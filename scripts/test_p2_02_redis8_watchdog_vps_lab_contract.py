"""Static regression checks for the isolated VPS watchdog laboratory script.

These tests never execute the laboratory, Docker or systemd. They ensure the
independent user timer stays armed until the disposable Redis is confirmed
running and cannot fire only once *before* the synthetic pause.
"""
from pathlib import Path
import subprocess
import unittest

LAB = Path(__file__).with_name("p2_02_redis8_watchdog_vps_lab.sh")
HELPER = Path(__file__).with_name("p2_02_redis8_synthetic_watchdog_vps.py")


class LabScriptSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = LAB.read_text(encoding="utf-8")
        cls.helper = HELPER.read_text(encoding="utf-8")

    def test_bash_syntax(self):
        result = subprocess.run(["bash", "-n", str(LAB)], check=False,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pinned_synthetic_container_only(self):
        self.assertIn('readonly NAME="vns-p2-redis-watchdog-lab-20261111"',
                      self.script)
        self.assertNotIn('"videonews-studio-redis-1"', self.script)
        self.assertIn('readonly IMAGE="redis:8.4.8-alpine@sha256:', self.script)
        self.assertIn("--network none", self.script)
        self.assertIn("--cap-drop ALL", self.script)
        self.assertIn("--user 1000:1000", self.script)
        self.assertIn("project=vns-p2-synthetic", self.script)

    def test_arm_timer_before_pausing(self):
        prepared = self.script.split("  --prepare)", 1)[1].split(
            "  --verify)", 1
        )[0]
        self.assertLess(
            prepared.index('systemctl --user start "$UNIT.timer"'),
            prepared.index('docker pause "$CID"'),
        )

    def test_timer_repeats_even_if_triggered_before_pause(self):
        self.assertIn("OnActiveSec=45s", self.script)
        self.assertIn("OnUnitInactiveSec=15s", self.script)
        self.assertIn("AccuracySec=1s", self.script)

    def test_verify_requires_post_pause_release_witness(self):
        verification = self.script.split("  --verify)", 1)[1].split(
            "  --cleanup)", 1
        )[0]
        self.assertIn('[[ -f "$PAUSE_MARKER"', verification)
        self.assertIn("STARTED_EPOCH > PAUSED_AT", verification)
        self.assertIn('journalctl --user -u "$UNIT.service"', verification)
        self.assertIn('"LAB_UNPAUSE_ATTEMPTED=true"', verification)

    def test_cleanup_keeps_timer_until_after_unpause(self):
        cleanup = self.script.split("  --cleanup)", 1)[1]
        self.assertLess(
            cleanup.index("policy_release >/dev/null"),
            cleanup.index('systemctl --user stop "$UNIT.timer"'),
        )
        self.assertLess(
            cleanup.index('"true|false" ]] || fail'),
            cleanup.index('systemctl --user stop "$UNIT.timer"'),
        )

    def test_recovery_helper_never_directly_pauses(self):
        self.assertNotIn('["docker", "pause"', self.helper)
        self.assertNotIn('["docker", "restart"', self.helper)
        self.assertNotIn('["docker", "rm"', self.helper)
        self.assertIn('["docker", "unpause", cid]', self.helper)


if __name__ == "__main__":
    unittest.main()
