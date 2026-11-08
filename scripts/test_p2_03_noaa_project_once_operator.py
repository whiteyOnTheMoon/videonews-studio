#!/usr/bin/env python3
"""Static and negative admission tests; never launch Docker or SQL."""
from pathlib import Path
import re
import subprocess
import unittest

SCRIPT = Path(__file__).with_name("p2_03_noaa_project_once_operator.sh")


class OneShotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT.read_text(encoding="utf-8")

    def test_bash_syntax(self):
        p = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True,
                           text=True, timeout=5)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_preflight_must_precede_every_mutation(self):
        before, after = self.script.split('mkdir -m 0700 -- "$ATTEMPT_DIR"', 1)
        for required in (
            'test "$ACTION" = "preflight"',
            'REPORT="$(python3 "$PRE" --preflight --expected-sha "$SHA")"',
            'test ! -e "$ATTEMPT_DIR"',
            'test ! -L "$ATTEMPT_DIR"',
            '"reviewable_no_write"',
            '"database_changed"] is False',
            '"projection_authorized"] is False',
            '"publication_authorized"] is False',
        ):
            self.assertIn(required, before)
        self.assertNotIn('docker create \\', before)
        self.assertNotIn('docker start --attach', before)
        self.assertIn('docker create \\', after)
        self.assertIn('docker start --attach "$CONTAINER"', after)

    def test_fixed_source_image_login_and_limit(self):
        for required in (
            'vns-noaa-project-20261108-a5c73c9',
            'sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef',
            'vns_feed_project_login_prod',
            'VNS_P2_FEED_PROJECTION_SOURCE_ID=noaa_news',
            'VNS_P2_FEED_PROJECTION_LIMIT=8',
            'VNS_P2_FEED_PROJECTION_MODE=single_pass',
            'VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP=false',
            'NOAA_HISTORICAL_DB_ONLY_PROJECTION_ONCE_NO_RETRY',
        ):
            self.assertIn(required, self.script)

    def test_limited_rootless_no_egress(self):
        for required in (
            '--user 10004:10004', '--restart no', '--read-only',
            '--cap-drop ALL', '--security-opt no-new-privileges',
            '--pids-limit 48', '--memory 192m', '--memory-swap 192m',
            '--cpus 0.25', '--pull never',
            '--network "$BACKEND"', '--init',
            'vns_feed_project_db_password,readonly',
        ):
            self.assertIn(required, self.script)
        for forbidden in (
            'docker run', 'docker rm', 'docker restart',
            'docker network connect', 'docker compose',
            'docker pull', 'docker build', 'curl ', 'wget ',
            'redis-cli', '--publish', '--privileged', '--network host',
            '--net=host', 'source-export-db-password',
        ):
            self.assertNotIn(forbidden, self.script)
        self.assertEqual(len(re.findall(r'^docker create\b', self.script, re.M)), 1)
        self.assertEqual(len(re.findall(r'^docker start --attach\b', self.script, re.M)), 1)

    def test_audit_failure_remains_nonretryable(self):
        self.assertIn('mkdir -m 0700 -- "$ATTEMPT_DIR"', self.script)
        self.assertIn('test ! -e "$ATTEMPT_DIR" && test ! -L "$ATTEMPT_DIR"', self.script)
        self.assertIn('START_STATUS="$?"', self.script)
        self.assertIn('test "$STATE" != "exited|0|0"', self.script)
        self.assertNotIn('docker rm', self.script)
        self.assertNotIn('rm -', self.script)

    def test_invalid_cli_denied_without_any_privileged_operation(self):
        for args in (
            ["--run", "--expected-sha", "0"*40],
            ["--run", "--expected-sha", "0"*40, "--approval", "NO"],
            ["--preflight", "--expected-sha", "INVALID"],
        ):
            with self.subTest(args=args):
                r = subprocess.run(["bash", str(SCRIPT), *args],
                                   capture_output=True, text=True, timeout=5)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("REFUSED:", r.stderr)


if __name__ == "__main__":
    unittest.main()
