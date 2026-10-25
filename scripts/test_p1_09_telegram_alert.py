import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from p1_09_telegram_alert import (
    COOLDOWN_SECONDS, alert_needed, main, notify_once, private_file,
)

GIB = 1024 ** 3


class TelegramAlertTests(unittest.TestCase):
    def test_alert_transitions_and_six_hour_throttle(self):
        self.assertFalse(alert_needed(None, "OK", 100))
        self.assertTrue(alert_needed(None, "WARN", 100))
        previous = {"level": "WARN", "sent_at": 100}
        self.assertFalse(alert_needed(previous, "WARN", 100 + 15 * 60))
        self.assertTrue(alert_needed(previous, "CRITICAL", 200))
        self.assertTrue(alert_needed(previous, "UNKNOWN", 200))
        self.assertTrue(alert_needed(previous, "OK", 200))
        self.assertFalse(alert_needed(previous, "WARN", 100 + COOLDOWN_SECONDS - 1))
        self.assertTrue(alert_needed(previous, "WARN", 100 + COOLDOWN_SECONDS))
        self.assertFalse(alert_needed({"level": "OK", "sent_at": 100}, "OK", 200))

    def test_invalid_state_refuses(self):
        invalid = [
            {"level": "??", "sent_at": 0},
            {"level": "WARN", "sent_at": True},
            {"level": "WARN", "sent_at": 9999},
            ["WARN"],
            {},
        ]
        for previous in invalid:
            with self.subTest(previous=previous):
                with self.assertRaises((ValueError, TypeError)):
                    alert_needed(previous, "WARN", 100)

    def test_delivery_is_deduplicated_and_recovery_is_reported(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            conf = root / "cfg"
            conf.mkdir(mode=0o700)
            token = "123456789:" + "A" * 36
            for name, content in (
                ("telegram_token", token),
                ("telegram_chat_id", "123456789"),
            ):
                path = conf / name
                path.write_text(content)
                path.chmod(0o600)
            state = root / "state"
            state.mkdir(mode=0o700)
            alerts = []

            def sender(sent_token, chat, message):
                self.assertEqual(sent_token, token)
                self.assertEqual(chat, "123456789")
                alerts.append(message)

            warning = SimpleNamespace(level="WARN", free_bytes=15 * GIB, free_percent=12.0)
            with patch("p1_09_telegram_alert.check_disk", return_value=warning):
                self.assertEqual(
                    notify_once(now=100, sender=sender, config_dir=conf, state_dir=state),
                    "ALERT_SENT",
                )
                self.assertEqual(
                    notify_once(now=200, sender=sender, config_dir=conf, state_dir=state),
                    "NO_ALERT",
                )
                self.assertEqual(
                    notify_once(
                        now=100 + COOLDOWN_SECONDS,
                        sender=sender, config_dir=conf, state_dir=state,
                    ),
                    "ALERT_SENT",
                )
            healthy = SimpleNamespace(level="OK", free_bytes=40 * GIB, free_percent=30.0)
            with patch("p1_09_telegram_alert.check_disk", return_value=healthy):
                self.assertEqual(
                    notify_once(
                        now=100 + COOLDOWN_SECONDS + 1,
                        sender=sender, config_dir=conf, state_dir=state,
                    ),
                    "ALERT_SENT",
                )
                self.assertEqual(
                    notify_once(
                        now=100 + COOLDOWN_SECONDS + 2,
                        sender=sender, config_dir=conf, state_dir=state,
                    ),
                    "NO_ALERT",
                )
            self.assertEqual(len(alerts), 3)
            self.assertTrue(alerts[-1].startswith("VideoNews Studio disk OK"))
            self.assertEqual((state / "disk-alert-state.json").stat().st_mode & 0o777, 0o600)

    def test_failed_delivery_is_retried_without_acknowledgment(self):
        with tempfile.TemporaryDirectory() as base:
            root = Path(base)
            conf = root / "cfg"
            conf.mkdir(mode=0o700)
            for name, content in (
                ("telegram_token", "123456789:" + "A" * 36),
                ("telegram_chat_id", "123456789"),
            ):
                path = conf / name
                path.write_text(content)
                path.chmod(0o600)
            state = root / "state"
            state.mkdir(mode=0o700)
            warning = SimpleNamespace(level="WARN", free_bytes=15 * GIB, free_percent=12.0)
            with patch("p1_09_telegram_alert.check_disk", return_value=warning):
                def failure(*_):
                    raise OSError("private transport failure")

                with self.assertRaises(OSError):
                    notify_once(now=100, sender=failure, config_dir=conf, state_dir=state)
                self.assertFalse((state / "disk-alert-state.json").exists())
                self.assertEqual(
                    notify_once(
                        now=200, sender=lambda *_: None,
                        config_dir=conf, state_dir=state,
                    ),
                    "ALERT_SENT",
                )

    def test_secret_file_rejects_world_readable_or_symlink(self):
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / "token"
            path.write_text("testing")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                private_file(path)
            path.chmod(0o600)
            alias = Path(base) / "link"
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                private_file(alias)

    def test_no_send_argument_refuses_without_network(self):
        with patch("p1_09_telegram_alert.send_telegram", side_effect=AssertionError("NETWORK")):
            with self.assertRaises(SystemExit) as exit_code:
                main([])
            self.assertEqual(exit_code.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
