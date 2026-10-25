"""Static tests only; never start, install or enable a systemd unit."""
import configparser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
UNITS = ROOT / "ops" / "p1-09"


def parse_unit(name):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    with (UNITS / name).open(encoding="utf-8") as file:
        parser.read_file(file)
    return parser


class DiskWatchUnitTests(unittest.TestCase):
    def test_timer_is_opt_in_quarter_hour_and_local_only(self):
        unit = parse_unit("vns-disk-watch.timer")
        self.assertEqual(unit["Timer"]["OnCalendar"], "*:0/15")
        self.assertEqual(unit["Timer"]["Unit"], "vns-disk-watch.service")
        self.assertEqual(unit["Install"]["WantedBy"], "timers.target")
        self.assertEqual(unit["Timer"]["Persistent"], "true")
        self.assertNotIn("OnBootSec", unit["Timer"])

    def test_service_is_only_read_only_probe_as_unprivileged_user(self):
        unit = parse_unit("vns-disk-watch.service")
        service = unit["Service"]
        self.assertEqual(service["Type"], "oneshot")
        self.assertEqual(service["User"], "ap")
        self.assertEqual(service["Group"], "ap")
        self.assertEqual(
            service["ExecStart"],
            "/usr/bin/python3 /home/ap/www/videonews-studio/scripts/p1_09_disk_watch.py "
            "--path /home/ap/www/videonews-studio",
        )
        self.assertEqual(service["StandardOutput"], "journal")
        self.assertEqual(service["StandardError"], "journal")
        self.assertEqual(service["SyslogIdentifier"], "videonews-disk-watch")
        for forbidden in ("ExecStartPre", "ExecStartPost", "ExecStop", "ExecReload"):
            self.assertNotIn(forbidden, service)
        for key, expected in {
            "NoNewPrivileges": "yes",
            "PrivateTmp": "yes",
            "PrivateNetwork": "yes",
            "PrivateDevices": "yes",
            "ProtectSystem": "strict",
            "ProtectHome": "read-only",
            "ProtectKernelTunables": "yes",
            "ProtectKernelModules": "yes",
            "ProtectControlGroups": "yes",
            "ProtectClock": "yes",
            "RestrictSUIDSGID": "yes",
            "LockPersonality": "yes",
            "RestrictAddressFamilies": "AF_UNIX",
            "CapabilityBoundingSet": "",
            "AmbientCapabilities": "",
            "UMask": "0077",
        }.items():
            with self.subTest(setting=key):
                self.assertEqual(service[key], expected)

    def test_no_service_automation_is_self_installed(self):
        for path in UNITS.glob("*"):
            self.assertIn(path.suffix, (".timer", ".service"))
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("curl ", text)
            self.assertNotIn("docker ", text)
            self.assertNotIn("systemctl ", text)
            self.assertNotIn("/bin/sh ", text)
            self.assertNotIn("EnvironmentFile=", text)


if __name__ == "__main__":
    unittest.main()
