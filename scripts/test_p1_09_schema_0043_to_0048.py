#!/usr/bin/env python3
"""Offline gate tests: no database connection, no secrets, no VPS mutations."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import p1_09_schema_0043_to_0048 as upgrade


class Schema0048UpgradeTests(unittest.TestCase):
    def test_exact_migrations_and_reject_symlink(self):
        versions = upgrade.expected_versions()
        self.assertEqual(len(versions), 48)
        self.assertEqual(versions[42], "0043_claimed_provider_secret_scope")
        self.assertEqual(versions[43], "0044_named_provider_job_authorization")
        self.assertEqual(versions[-1], "0048_provider_outbox_delivery_receipt")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in versions:
                (root / (name + ".up.sql")).write_text(
                    "-- synthetic fixture " + "a" * 120 + "\nBEGIN;\nSELECT 1;\nCOMMIT;\n", encoding="utf8"
                )
            with patch.object(upgrade, "MIGRATIONS", root):
                self.assertEqual(upgrade.expected_versions(), versions)
                path = root / (versions[-1] + ".up.sql")
                path.unlink()
                path.symlink_to(root / (versions[-2] + ".up.sql"))
                with self.assertRaises(RuntimeError):
                    upgrade.expected_versions()

    def test_preflight_refuses_wrong_schema_roles_or_provider_flags(self):
        versions = upgrade.expected_versions()
        state = "vns|videonews|on|170006|0|0|0|0|0"
        with patch.object(upgrade, "ledger", return_value=versions[:43]), patch.object(
            upgrade, "query",
            side_effect=lambda _c, sql: state if "current_user" in sql else "t",
        ), patch.object(upgrade, "resources"):
            upgrade.preflight("ci", versions, True)
        for invalid in [
            "vns|videonews|off|170006|0|0|0|0|0",
            "vns|videonews|on|170006|1|0|0|0|0",
            "vns|videonews|on|170006|0|1|0|0|0",
            "vns|videonews|on|170006|0|0|1|0|0",
            "vns|videonews|on|170006|0|0|0|1|0",
        ]:
            with patch.object(upgrade, "ledger", return_value=versions[:43]), patch.object(
                upgrade, "query",
                side_effect=lambda _c, sql: invalid if "current_user" in sql else "t",
            ), patch.object(upgrade, "resources"):
                with self.assertRaises(RuntimeError):
                    upgrade.preflight("ci", versions, True)
        with patch.object(upgrade, "ledger", return_value=versions[:44]):
            with self.assertRaises(RuntimeError):
                upgrade.preflight("ci", versions, True)
        with patch.object(upgrade, "ledger", return_value=versions[:43]), patch.object(
            upgrade, "query", side_effect=lambda _c, sql: state if "current_user" in sql else "f"
        ), patch.object(upgrade, "resources"):
            with self.assertRaises(RuntimeError):
                upgrade.preflight("ci", versions, True)

    def test_approval_and_exact_release_sha_required_before_writes(self):
        versions = upgrade.expected_versions()
        with patch.object(upgrade, "ci_fixture", return_value=False), patch.object(
            upgrade, "git_state", return_value="a" * 40
        ), patch.object(upgrade, "container_name", return_value="ci-only"), patch.object(
            upgrade, "expected_versions", return_value=versions
        ), patch.object(upgrade, "preflight", side_effect=AssertionError("no SQL")):
            with patch.dict("os.environ", {}, clear=True):
                with self.assertRaises(RuntimeError):
                    upgrade.main(["--apply"])
            with patch.dict("os.environ", {
                upgrade.APPROVAL: "APPLY_ADDITIVE_0044_0048",
                upgrade.SHA_APPROVAL: "b" * 40
            }):
                with self.assertRaises(RuntimeError):
                    upgrade.main(["--apply"])

    def test_sequential_ledger_check_and_abort_never_retry(self):
        versions = upgrade.expected_versions()
        current = versions[:43].copy()
        queries = []
        def query(_container, sql, readonly=True, timeout=40):
            self.assertFalse(readonly)
            self.assertEqual(timeout, 140)
            self.assertIn("BEGIN;", sql)
            self.assertTrue(sql.rstrip().endswith("COMMIT;"))
            queries.append(sql)
            current.append(versions[len(current)])
            return ""
        with patch.object(upgrade, "ledger", side_effect=lambda _c: current.copy()), patch.object(
            upgrade, "query", side_effect=query
        ), patch.object(upgrade, "final_check"):
            upgrade.apply("ci", versions)
        self.assertEqual(len(queries), 5)
        current = versions[:43].copy()
        def interrupted(_container, sql, readonly=True, timeout=40):
            if len(current) >= 45:
                raise RuntimeError("unexpected SQL uncertainty")
            current.append(versions[len(current)])
            return ""
        with patch.object(upgrade, "ledger", side_effect=lambda _c: current.copy()), patch.object(
            upgrade, "query", side_effect=interrupted
        ), patch.object(upgrade, "final_check", side_effect=AssertionError("not reached")):
            with self.assertRaises(RuntimeError):
                upgrade.apply("ci", versions)
        self.assertEqual(len(current), 45)

    def test_final_acl_boolean_text_matches_real_postgres_output(self):
        versions = upgrade.expected_versions()
        expected = "0|0|0|2|0|0|true|true|false"
        with patch.object(upgrade, "ledger", return_value=versions), patch.object(
            upgrade, "query", return_value=expected
        ):
            upgrade.final_check("ci", versions)
        for unsafe in [
            "0|0|0|2|0|0|true|true|true",
            "0|0|0|1|0|0|true|true|false",
            "0|0|1|2|0|0|true|true|false",
            "0|0|0|2|0|0|false|true|false",
        ]:
            with patch.object(upgrade, "ledger", return_value=versions), patch.object(
                upgrade, "query", return_value=unsafe
            ):
                with self.assertRaises(RuntimeError):
                    upgrade.final_check("ci", versions)

    def test_failed_sql_is_redacted(self):
        fake = subprocess.CompletedProcess(
            args=["psql"], returncode=1, stdout="SECRET SQL", stderr="SCRAM verifier"
        )
        with patch.object(upgrade.subprocess, "run", return_value=fake):
            with self.assertRaises(RuntimeError) as e:
                upgrade.command(["false"])
        self.assertEqual(str(e.exception), upgrade.FAIL)
        self.assertNotIn("SECRET", str(e.exception))


if __name__ == "__main__":
    unittest.main()
