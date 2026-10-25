import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from p1_09_email_alert import (
    email_settings, main, notify_once, send_test_email, smtp_send,
)

GIB = 1024 ** 3


def fixture(directory):
    cfg = directory / "cfg"
    cfg.mkdir(mode=0o700)
    settings = {
        "smtp_host": "smtp.example.org",
        "smtp_username": "robot@example.org",
        "email_from": "robot@example.org",
        "email_to": "operator@example.net",
    }
    file = cfg / "email_config.json"
    file.write_text(json.dumps(settings), encoding="ascii")
    file.chmod(0o600)
    password = cfg / "email_smtp_password"
    password.write_text("synthetic_test_app_password\n", encoding="ascii")
    password.chmod(0o600)
    return cfg


class EmailAlertTests(unittest.TestCase):
    def test_private_configuration_and_strict_addresses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = fixture(root)
            settings = email_settings(cfg)
            self.assertEqual(settings["host"], "smtp.example.org")
            self.assertEqual(settings["recipient"], "operator@example.net")
            cfg_file = cfg / "email_config.json"
            cfg_file.chmod(0o644)
            with self.assertRaises(ValueError):
                email_settings(cfg)
            cfg_file.chmod(0o600)
            original = json.loads(cfg_file.read_text(encoding="ascii"))
            for bad in [
                {"smtp_host": "127.0.0.1"},
                {"smtp_host": "localhost"},
                {"smtp_host": "smtp.local"},
                {"smtp_host": "smtp.internal"},
                {"email_to": "a@example.org\nBcc: x@example.org"},
                {"email_to": "a@example.org,b@example.org"},
                {"email_to": "bad@@example.org"},
                {"unexpected": "setting"},
            ]:
                with self.subTest(bad=bad):
                    cfg_file.write_text(json.dumps({**original, **bad}), encoding="ascii")
                    with self.assertRaises(ValueError):
                        email_settings(cfg)
            cfg_file.write_text(json.dumps(original), encoding="ascii")
            symlink = cfg / "email_config.link"
            symlink.symlink_to(cfg_file)
            cfg_file.rename(cfg / "email_config.old")
            symlink.rename(cfg_file)
            with self.assertRaises(OSError):
                email_settings(cfg)

    def test_implicit_tls_with_checked_recipient(self):
        class FakeSmtp:
            instance = None

            def __init__(self, host, port, timeout, context):
                self.details = (host, port, timeout)
                self.context = context
                self.auth = None
                self.sent = None
                FakeSmtp.instance = self

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def login(self, username, password):
                self.auth = (username, password)

            def send_message(self, message, from_addr, to_addrs):
                self.sent = (message, from_addr, to_addrs)
                return {}

        with tempfile.TemporaryDirectory() as tmp:
            settings = email_settings(fixture(Path(tmp)))
            with patch("p1_09_email_alert.smtplib.SMTP_SSL", FakeSmtp):
                smtp_send(settings, "Disk WARN", "Synthetic metric")
            smtp = FakeSmtp.instance
            self.assertEqual(smtp.details, ("smtp.example.org", 465, 12))
            self.assertIsNotNone(smtp.context)
            self.assertEqual(smtp.auth[0], "robot@example.org")
            self.assertEqual(smtp.sent[2], ["operator@example.net"])
            self.assertEqual(smtp.sent[0]["Subject"], "Disk WARN")
            self.assertNotIn("synthetic_test_app_password", smtp.sent[0].as_string())

    def test_initial_healthy_does_not_send_or_read_password(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            state_dir.mkdir(mode=0o700)
            healthy = SimpleNamespace(level="OK", free_bytes=30 * GIB, free_percent=35.0)
            with patch("p1_09_email_alert.check_disk", return_value=healthy):
                result = notify_once(
                    state_dir=state_dir, config_dir=Path(tmp) / "does-not-exist",
                    now=100, sender=lambda *_: self.fail("Never send initial OK"),
                )
            self.assertEqual(result, "NO_ALERT")
            self.assertEqual(
                json.loads((state_dir / "disk-email-state.json").read_text()),
                {"level": "OK", "sent_at": 100},
            )

    def test_warning_throttle_severity_change_and_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = fixture(root)
            state_dir = root / "state"
            state_dir.mkdir(mode=0o700)
            sent = []

            def sender(settings, subject, body):
                sent.append((settings["recipient"], subject, body))

            samples = [
                (100, "WARN", 15),
                (200, "WARN", 15),
                (300, "CRITICAL", 8),
                (400, "CRITICAL", 8),
                (300 + 6 * 3600, "CRITICAL", 8),
                (300 + 6 * 3600 + 1, "OK", 40),
                (300 + 6 * 3600 + 2, "OK", 40),
            ]
            results = []
            for now, level, free in samples:
                reading = SimpleNamespace(
                    level=level, free_bytes=free * GIB, free_percent=float(free)
                )
                with patch("p1_09_email_alert.check_disk", return_value=reading):
                    results.append(notify_once(
                        config_dir=cfg, state_dir=state_dir, now=now, sender=sender
                    ))
            self.assertEqual(
                results,
                ["ALERT_SENT", "NO_ALERT", "ALERT_SENT", "NO_ALERT",
                 "ALERT_SENT", "ALERT_SENT", "NO_ALERT"],
            )
            self.assertEqual(len(sent), 4)
            self.assertIn("CRITICAL", sent[1][1])
            self.assertIn("OK", sent[-1][1])
            self.assertEqual((state_dir / "disk-email-state.json").stat().st_mode & 0o777, 0o600)

    def test_failed_smtp_keeps_alert_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = fixture(root)
            state_dir = root / "state"
            state_dir.mkdir(mode=0o700)
            disk = SimpleNamespace(level="WARN", free_bytes=15 * GIB, free_percent=14.0)
            with patch("p1_09_email_alert.check_disk", return_value=disk):
                def failure(*_):
                    raise OSError("Private auth detail")
                with self.assertRaises(OSError):
                    notify_once(config_dir=cfg, state_dir=state_dir, now=100, sender=failure)
                self.assertFalse((state_dir / "disk-email-state.json").exists())
                self.assertEqual(
                    notify_once(config_dir=cfg, state_dir=state_dir, now=200,
                                sender=lambda *_: None),
                    "ALERT_SENT",
                )

    def test_test_email_is_explicit_and_never_changes_disk_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = fixture(root)
            sent = []
            self.assertEqual(
                send_test_email(sender=lambda *args: sent.append(args), directory=cfg),
                "TEST_SENT",
            )
            self.assertEqual(len(sent), 1)
            self.assertIn("Test", sent[0][1])
            self.assertFalse((root / "state").exists())

    def test_missing_mode_cannot_send_and_raw_smtp_error_is_sanitized(self):
        with patch("p1_09_email_alert.smtp_send", side_effect=AssertionError("NETWORK")):
            with self.assertRaises(SystemExit) as stopped:
                main([])
            self.assertEqual(stopped.exception.code, 2)
        with patch("p1_09_email_alert.email_settings", side_effect=OSError("SMTP SECRET")):
            self.assertEqual(main(["--test-email"]), 4)


if __name__ == "__main__":
    unittest.main()
