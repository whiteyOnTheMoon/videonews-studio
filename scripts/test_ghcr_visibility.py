"""Offline regression tests for safe, authenticated GHCR metadata inspection.

No real GitHub API, packages, or credentials are used.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts" / "check_ghcr_visibility.sh"

FAKE_CURL = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
out = Path(args[args.index("--output") + 1])
name = args[-1].rsplit("/", 1)[-1]
prefix = "MOCK_WEB_" if name.endswith("-web") else "MOCK_API_"
status = os.environ.get(prefix + "STATUS", "200")
if os.environ.get(prefix + "BAD_JSON") == "true":
    out.write_text("{invalid-json", encoding="utf-8")
else:
    visibility = os.environ.get(prefix + "VISIBILITY", "private")
    out.write_text(json.dumps({"name": name, "visibility": visibility}), encoding="utf-8")
sys.stdout.write(status)
"""


class CheckGhcrVisibilityTests(unittest.TestCase):
    def run_case(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "curl"
            fake.write_text(FAKE_CURL, encoding="utf-8")
            fake.chmod(0o755)
            environment = os.environ.copy()
            environment.update({
                "PATH": directory + os.pathsep + environment["PATH"],
                "GHCR_TOKEN": "dummy-not-a-secret",
            })
            environment.update(overrides)
            result = subprocess.run(
                ["bash", str(CHECK)],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertNotIn("dummy-not-a-secret", result.stdout + result.stderr)
            return result

    def test_existing_private_packages_allowed(self):
        result = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified private GHCR package", result.stdout)

    def test_nonexistent_names_allowed_only_with_manual_gate(self):
        result = self.run_case(MOCK_WEB_STATUS="404", MOCK_API_STATUS="404")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("manually confirm", result.stdout)

    def test_any_public_package_blocks(self):
        for field in ("MOCK_WEB_VISIBILITY", "MOCK_API_VISIBILITY"):
            with self.subTest(field=field):
                result = self.run_case(**{field: "public"})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("BLOCKED", result.stderr)

    def test_api_errors_block(self):
        for code in ("401", "403", "429", "500"):
            with self.subTest(code=code):
                result = self.run_case(MOCK_WEB_STATUS=code)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("BLOCKED", result.stderr)

    def test_missing_or_corrupt_visibility_blocks(self):
        for options in ({"MOCK_WEB_BAD_JSON": "true"}, {"MOCK_WEB_VISIBILITY": "unknown"}):
            with self.subTest(options=options):
                result = self.run_case(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("BLOCKED", result.stderr)

    def test_token_required(self):
        environment = os.environ.copy()
        environment.pop("GHCR_TOKEN", None)
        result = subprocess.run(
            ["bash", str(CHECK)], env=environment,
            capture_output=True, text=True, timeout=10, check=False,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
