#!/usr/bin/env python3
"""Offline, fail-closed contract tests; never contact VPS/Docker/SQL."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

FILE = Path(__file__).with_name("p2_03_noaa_projector_readonly_preflight.py")
spec = importlib.util.spec_from_file_location("noaa_projector_preflight", FILE)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class PreflightContractTests(unittest.TestCase):
    def valid(self):
        return {
            **module.EXPECTED_COUNTS,
            "read_only": True, "schema_ready": True,
            "source_ready": True, "host_grant_ready": True,
            "projector_login": "vns_feed_project_login_prod",
        }

    def test_valid_snapshot(self):
        self.assertEqual(module.validate_snapshot(self.valid())["missing"], 8)

    def test_every_count_is_fail_closed(self):
        for key, value in module.EXPECTED_COUNTS.items():
            for replacement in (value + 1, str(value), True, None):
                with self.subTest(key=key, replacement=replacement):
                    row = self.valid()
                    row[key] = replacement
                    with self.assertRaises(RuntimeError):
                        module.validate_snapshot(row)

    def test_every_boolean_guard_is_mandatory(self):
        for key in ("read_only", "schema_ready", "source_ready",
                    "host_grant_ready"):
            for bad in (False, None, 1):
                row = self.valid()
                row[key] = bad
                with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeError):
                    module.validate_snapshot(row)

    def test_invalid_login_is_denied(self):
        for value in ("postgres", "vns_feed_project_login_", "", None,
                      "vns_feed_project_login_prod; DROP TABLE x"):
            row = self.valid()
            row["projector_login"] = value
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                module.validate_snapshot(row)

    def test_release_root_and_sha_must_be_explicit(self):
        with patch.object(module.os, "geteuid", return_value=1000):
            with self.assertRaises(RuntimeError):
                module.verify_release("e17bff79331840f28ceecb5afb8f2919e11d0a05")
        with patch.object(module.os, "geteuid", return_value=0):
            with self.assertRaises(RuntimeError):
                module.verify_release("main")

    def test_readonly_guards_and_no_operator_run_mode(self):
        text = FILE.read_text(encoding="utf-8")
        for required in (
            '"--no-optional-locks"', 'GIT_OPTIONAL_LOCKS="0"',
            'default_transaction_read_only=on', 'statement_timeout=10000',
            'lock_timeout=3000', 'vns_feed_project_client',
            'vns.project_approved_feed_candidates(text,integer)',
            'vns.project_feed_candidates(text,integer)', 'forbidden_access',
            '10', 'SIGNED',
        ):
            if required == 'SIGNED':
                required = "p2_02_nasa_signed_sql_readonly_witness.py"
            self.assertIn(required, text)
        for forbidden in (
            '"create"', '"start"', '"run"', '"network", "connect"',
            '"compose", "up"', '"docker", "build"', '"docker", "pull"',
            'os.chown(', 'os.chmod(', 'open(SECRET',
        ):
            self.assertNotIn(forbidden, text)
        self.assertIn('parser.add_argument("--preflight"', text)
        self.assertNotIn('parser.add_argument("--run"', text)


if __name__ == "__main__":
    unittest.main()
