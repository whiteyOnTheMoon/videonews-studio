"""Pure static tests: do not install, start or contact SMTP."""
import configparser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / "ops" / "p1-09"


def unit(filename):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    with (DIRECTORY / filename).open(encoding="utf-8") as handle:
        parser.read_file(handle)
    return parser


class EmailSystemdTests(unittest.TestCase):
    def test_opt_in_timer_is_separate_from_live_journal_timer(self):
        timer = unit("vns-disk-email.timer")
        self.assertEqual(timer["Timer"]["OnCalendar"], "*:0/15")
        self.assertEqual(timer["Timer"]["Unit"], "vns-disk-email.service")
        self.assertEqual(timer["Install"]["WantedBy"], "timers.target")
        local = unit("vns-disk-watch.timer")
        self.assertEqual(local["Timer"]["Unit"], "vns-disk-watch.service")

    def test_mail_delivery_has_only_explicit_opt_in_execution(self):
        service = unit("vns-disk-email.service")["Service"]
        self.assertEqual(service["User"], "ap")
        self.assertEqual(service["Group"], "ap")
        self.assertEqual(service["Type"], "oneshot")
        self.assertEqual(service["StandardOutput"], "journal")
        self.assertEqual(service["StandardError"], "journal")
        self.assertIn("p1_09_email_alert.py --send ", service["ExecStart"])
        self.assertIn("--state-dir /var/lib/vns-disk-email", service["ExecStart"])
        self.assertEqual(service["StateDirectory"], "vns-disk-email")
        self.assertEqual(service["StateDirectoryMode"], "0700")
        for forbidden in ("ExecStartPre", "ExecStartPost", "ExecStop", "ExecReload"):
            self.assertNotIn(forbidden, service)
        expected = {
            "NoNewPrivileges": "yes",
            "PrivateTmp": "yes",
            "PrivateDevices": "yes",
            "ProtectSystem": "strict",
            "ProtectHome": "read-only",
            "ProtectKernelTunables": "yes",
            "ProtectKernelModules": "yes",
            "ProtectControlGroups": "yes",
            "ProtectClock": "yes",
            "RestrictSUIDSGID": "yes",
            "LockPersonality": "yes",
            "CapabilityBoundingSet": "",
            "AmbientCapabilities": "",
            "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6",
            "UMask": "0077",
        }
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertEqual(service[key], value)

    def test_no_self_activation_or_host_changes(self):
        for filename in ("vns-disk-email.service", "vns-disk-email.timer"):
            data = (DIRECTORY / filename).read_text(encoding="utf-8")
            for prohibited in ("systemctl ", "docker ", "curl ", "EnvironmentFile="):
                self.assertNotIn(prohibited, data)
        self.assertIn("PrivateNetwork=yes",
                      (DIRECTORY / "vns-disk-watch.service").read_text())


if __name__ == "__main__":
    unittest.main()
