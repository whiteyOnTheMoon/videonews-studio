#!/usr/bin/env python3
"""Optional SMTP-over-TLS disk alerts; never connects without explicit send/test."""
import argparse
from email.message import EmailMessage
import fcntl
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
import time

from p1_09_disk_watch import DEFAULT_PATH, check_disk
# Reuse the tested state/throttle policy; importing this module never
# creates a Telegram client or sends a network request.
from p1_09_telegram_alert import alert_needed, private_dir, private_file, read_state, save_state

CONFIG_DIR = Path("/home/ap/.config/videonews-studio/disk-alert")
STATE_DIR = Path("/home/ap/.local/state/videonews-studio")
SMTP_HOST = re.compile(
    r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
ADDRESS = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$")
FIELDS = frozenset(("smtp_host", "smtp_username", "email_from", "email_to"))


def email_settings(directory=CONFIG_DIR):
    """Read only operator-owned local files; fail closed on symlinks/permissions."""
    private_dir(directory)
    config_path = directory / "email_config.json"
    fd = os.open(config_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or not 2 <= info.st_size <= 1024
        ):
            raise ValueError("Email configuration file invalid")
        config = json.loads(os.read(fd, 1025))
    finally:
        os.close(fd)
    if not isinstance(config, dict) or set(config) != FIELDS:
        raise ValueError("Email settings invalid")
    host = config["smtp_host"]
    username = config["smtp_username"]
    sender = config["email_from"]
    recipient = config["email_to"]
    if (
        not isinstance(host, str)
        or not SMTP_HOST.fullmatch(host)
        or host.endswith((".local", ".localhost", ".internal", ".invalid", ".test", ".example"))
        or any(not isinstance(addr, str) or not ADDRESS.fullmatch(addr)
               for addr in (username, sender, recipient))
    ):
        raise ValueError("Email endpoint or address invalid")
    password = private_file(directory / "email_smtp_password")
    if not 8 <= len(password) <= 256 or "\n" in password or "\r" in password:
        raise ValueError("Email SMTP secret invalid")
    return {
        "host": host,
        "username": username,
        "password": password,
        "sender": sender,
        "recipient": recipient,
    }


def smtp_send(settings, subject, message):
    """Strict implicit TLS, fixed port 465, certificate verification, no fallback."""
    email = EmailMessage()
    email["From"] = settings["sender"]
    email["To"] = settings["recipient"]
    email["Subject"] = subject
    email.set_content(message)
    with smtplib.SMTP_SSL(
        settings["host"], 465, timeout=12, context=ssl.create_default_context()
    ) as connection:
        connection.login(settings["username"], settings["password"])
        rejected = connection.send_message(
            email, from_addr=settings["sender"], to_addrs=[settings["recipient"]]
        )
        if rejected:
            raise ValueError("SMTP server rejected recipient")


def send_test_email(sender=smtp_send, directory=CONFIG_DIR):
    """Explicit operator-only network test; does not alter warning state."""
    settings = email_settings(directory)
    sender(
        settings,
        "[VideoNews Studio] Test: Speicherplatzwarnung",
        "Diese Test-E-Mail bestaetigt den SMTP-Versand. Es liegt keine Speicherwarnung vor.",
    )
    return "TEST_SENT"


def notify_once(path=DEFAULT_PATH, now=None, sender=smtp_send,
                config_dir=CONFIG_DIR, state_dir=STATE_DIR):
    """Alert changes, six-hour reminders and recovery; never emit credentials."""
    now = int(time.time()) if now is None else now
    private_dir(state_dir, create=True)
    lock_path = state_dir / ".disk-email.lock"
    lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise ValueError("Email alert lock file invalid")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = state_dir / "disk-email-state.json"
        prior = read_state(state_path)
        try:
            assessment = check_disk(path)
            level = assessment.level
        except (OSError, ValueError):
            assessment, level = None, "UNKNOWN"
        if not alert_needed(prior, level, now):
            if prior is None and level == "OK":
                save_state(state_path, {"level": "OK", "sent_at": now})
            return "NO_ALERT"
        settings = email_settings(config_dir)
        if assessment is None:
            detail = "Speicherplatzwerte derzeit nicht lesbar."
        else:
            detail = (
                f"Freier Speicher: {assessment.free_bytes / (1024 ** 3):.1f} GiB "
                f"({assessment.free_percent:.1f}%)."
            )
        subject = f"[VideoNews Studio] Speicherplatz: {level}"
        body = (
            f"VideoNews Studio: {level}\n{detail}\n\n"
            "Dies ist eine automatische, lokale VPS-Speicherwarnung.\n"
            "Keine automatische Bereinigung und kein Neustart wurden ausgeloest.\n"
        )
        sender(settings, subject, body)
        # A failed send is never acknowledged; the next run can retry.
        save_state(state_path, {"level": level, "sent_at": now})
        return "ALERT_SENT"
    finally:
        os.close(lock)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check-config", action="store_true")
    modes.add_argument("--test-email", action="store_true")
    modes.add_argument("--send", action="store_true")
    parser.add_argument("--path", default=DEFAULT_PATH)
    parser.add_argument("--state-dir", type=Path, default=STATE_DIR)
    args = parser.parse_args(argv)
    try:
        if args.check_config:
            email_settings()
            print("DISK_EMAIL_CONFIG=READY")
        elif args.test_email:
            print("DISK_EMAIL_STATUS=" + send_test_email())
        else:
            print("DISK_EMAIL_STATUS=" + notify_once(path=args.path, state_dir=args.state_dir))
        return 0
    except Exception:
        # SMTP auth errors can include account details: never log raw exception.
        print("DISK_EMAIL_STATUS=UNAVAILABLE", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
