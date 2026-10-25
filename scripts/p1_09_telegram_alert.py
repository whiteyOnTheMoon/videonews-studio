#!/usr/bin/env python3
"""Opt-in Telegram disk alerts. No activation or network access without --send."""
import argparse
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import time
from urllib.parse import urlencode

from p1_09_disk_watch import DEFAULT_PATH, check_disk

CONFIG_DIR = Path("/home/ap/.config/videonews-studio/disk-alert")
STATE_DIR = Path("/home/ap/.local/state/videonews-studio")
COOLDOWN_SECONDS = 6 * 3600
LEVELS = frozenset(("OK", "WARN", "CRITICAL", "UNKNOWN"))
TOKEN = re.compile(r"^[0-9]{6,15}:[A-Za-z0-9_-]{30,90}$")
CHAT = re.compile(r"^-?[1-9][0-9]{0,19}$")


def alert_needed(previous, current, now):
    """Send on severity change, periodic persistence or recovery; never spam OK."""
    if current not in LEVELS or type(now) is not int or now < 0:
        raise ValueError("Invalid alert state")
    if previous is None:
        return current != "OK"
    if not isinstance(previous, dict) or set(previous) != {"level", "sent_at"}:
        raise ValueError("Invalid prior alert state")
    if previous["level"] not in LEVELS or type(previous["sent_at"]) is not int:
        raise ValueError("Invalid prior alert state")
    if previous["sent_at"] < 0 or previous["sent_at"] > now + 300:
        raise ValueError("Invalid prior alert timestamp")
    if current == "OK":
        return previous["level"] != "OK"
    return previous["level"] != current or now - previous["sent_at"] >= COOLDOWN_SECONDS


def private_dir(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    details = path.lstat()
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != os.geteuid():
        raise ValueError("Private alert directory unavailable")
    if stat.S_IMODE(details.st_mode) != 0o700:
        raise ValueError("Private alert directory permissions invalid")
    return path


def private_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or info.st_size < 1
            or info.st_size > 256
        ):
            raise ValueError("Private alert file invalid")
        return os.read(fd, 257).decode("ascii").strip()
    finally:
        os.close(fd)


def credentials(directory=CONFIG_DIR):
    private_dir(directory)
    token = private_file(directory / "telegram_token")
    chat_id = private_file(directory / "telegram_chat_id")
    if not TOKEN.fullmatch(token) or not CHAT.fullmatch(chat_id):
        raise ValueError("Telegram alert credentials invalid")
    return token, chat_id


def read_state(path):
    if not path.exists():
        return None
    raw = private_file(path)
    return json.loads(raw)


def save_state(path, state):
    """Same-filesystem exclusive file creation and atomic replacement."""
    tmp = path.with_name(path.name + ".tmp." + str(os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            json.dump(state, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def send_telegram(token, chat_id, message):
    """Fixed TLS destination. Raw transport errors must never enter logs."""
    body = urlencode({"chat_id": chat_id, "text": message, "disable_web_page_preview": "true"})
    connection = http.client.HTTPSConnection(
        "api.telegram.org", 443, timeout=8, context=ssl.create_default_context()
    )
    try:
        connection.request(
            "POST",
            "/bot" + token + "/sendMessage",
            body=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response = connection.getresponse()
        payload = response.read(4097)
        data = json.loads(payload) if len(payload) <= 4096 else None
        if response.status != 200 or not isinstance(data, dict) or data.get("ok") is not True:
            raise ValueError("Telegram notification rejected")
    finally:
        connection.close()


def notify_once(path=DEFAULT_PATH, now=None, sender=send_telegram,
                config_dir=CONFIG_DIR, state_dir=STATE_DIR):
    """Only called by explicit --send. Concurrent runs lock; failures retry."""
    now = int(time.time()) if now is None else now
    private_dir(state_dir, create=True)
    lock_fd = os.open(
        state_dir / ".disk-alert.lock",
        os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    try:
        lock_info = os.fstat(lock_fd)
        if (
            not stat.S_ISREG(lock_info.st_mode)
            or lock_info.st_uid != os.geteuid()
            or stat.S_IMODE(lock_info.st_mode) != 0o600
            or lock_info.st_nlink != 1
        ):
            raise ValueError("Alert lock invalid")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = state_dir / "disk-alert-state.json"
        previous = read_state(state_path)
        try:
            assessment = check_disk(path)
            level = assessment.level
        except (OSError, ValueError):
            assessment = None
            level = "UNKNOWN"
        if not alert_needed(previous, level, now):
            if previous is None and level == "OK":
                save_state(state_path, {"level": "OK", "sent_at": now})
            return "NO_ALERT"
        token, chat_id = credentials(config_dir)
        detail = (
            "free: %.1f GiB / %.1f%%"
            % (assessment.free_bytes / (1024 ** 3), assessment.free_percent)
            if assessment
            else "disk metrics unavailable"
        )
        message = "VideoNews Studio disk " + level + " - " + detail
        sender(token, chat_id, message)
        save_state(state_path, {"level": level, "sent_at": now})
        return "ALERT_SENT"
    finally:
        os.close(lock_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    options = parser.add_mutually_exclusive_group(required=True)
    options.add_argument("--send", action="store_true", help="Allow Telegram network delivery")
    options.add_argument("--check-config", action="store_true", help="Validate private files offline")
    parser.add_argument("--path", default=DEFAULT_PATH)
    args = parser.parse_args(argv)
    try:
        if args.check_config:
            credentials()
            print("TELEGRAM_ALERT_CONFIG=READY")
            return 0
        print("TELEGRAM_DISK_ALERT=" + notify_once(path=args.path))
        return 0
    except (OSError, ValueError, TypeError, http.client.HTTPException, ssl.SSLError,
            UnicodeError, json.JSONDecodeError):
        print("TELEGRAM_DISK_ALERT=UNAVAILABLE", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
