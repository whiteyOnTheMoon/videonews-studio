#!/usr/bin/env python3
"""Offline unit tests: no Docker, GitHub, provider or paid requests."""
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch

import p1_09_provider_worker_login_custody as custody


class WorkerLoginCustodyTests(unittest.TestCase):
    def test_exact_service_contract_and_scram_no_plaintext(self):
        self.assertEqual(
            [(a, b) for a, b, _ in custody.SERVICES],
            [
                ("vns_provider_usage_login", "vns_provider_usage_writer"),
                ("vns_provider_secret_login", "vns_provider_secret_reader"),
            ],
        )
        passwords = ["A" * 48, "B" * 48]
        sql = custody.role_transaction(passwords, [b"1" * 16, b"2" * 16])
        self.assertEqual(sql.count("CREATE ROLE"), 2)
        self.assertEqual(sql.count(" WITH INHERIT TRUE, SET FALSE;"), 2)
        self.assertEqual(sql.count("SCRAM-SHA-256$4096:"), 2)
        self.assertNotIn(passwords[0], sql)
        self.assertNotIn(passwords[1], sql)
        self.assertIn("vns_provider_usage_writer", sql)
        self.assertIn("vns_provider_secret_reader", sql)
        self.assertIn("vns.schema_migrations)<>43", sql)
        self.assertIn("ai_provider_sealed_credentials", sql)
        self.assertIn("provider_live_eur_policy WHERE enabled", sql)
        self.assertNotIn("DROP ROLE", sql)
        for bad in [
            (["A" * 48, "A" * 48], [b"1" * 16, b"2" * 16]),
            (["abc", "B" * 48], [b"1" * 16, b"2" * 16]),
            (["A" * 48], [b"1" * 16, b"2" * 16]),
            (["A" * 48, "B" * 48], [b"1" * 16]),
        ]:
            with self.assertRaises(ValueError):
                custody.role_transaction(*bad)

    def test_staging_is_exclusive_private_and_never_rotates(self):
        with tempfile.TemporaryDirectory(prefix="vns-p1-09-test-") as temp:
            directory = Path(temp) / "secrets"
            directory.mkdir(mode=0o700)
            uid = os.geteuid()
            with patch.object(custody, "SECRET_DIR", directory), patch.object(
                custody, "checked_command", side_effect=["main", ""]
            ):
                custody.stage(expected_uid=uid)
            with patch.object(custody, "SECRET_DIR", directory):
                values = custody.read_passwords(expected_uid=uid)
            self.assertEqual(len(values), 2)
            self.assertNotEqual(values[0], values[1])
            self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_-]{40,128}", x) for x in values))
            for _, _, name in custody.SERVICES:
                file = directory / name
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
                self.assertEqual(file.stat().st_nlink, 1)
            with patch.object(custody, "SECRET_DIR", directory), patch.object(
                custody, "checked_command", side_effect=["main", ""]
            ):
                with self.assertRaises(FileExistsError):
                    custody.stage(expected_uid=uid)
            with patch.object(custody, "SECRET_DIR", directory):
                self.assertEqual(custody.read_passwords(expected_uid=uid), values)

    def test_symlink_and_loose_permissions_fail_without_disclosing_secret(self):
        uid = os.geteuid()
        with tempfile.TemporaryDirectory(prefix="vns-p1-09-test-") as temp:
            directory = Path(temp) / "secrets"
            directory.mkdir(mode=0o700)
            first, second = [x[2] for x in custody.SERVICES]
            (directory / first).write_text("A" * 48 + "\n", encoding="ascii")
            os.chmod(directory / first, 0o600)
            (directory / second).symlink_to(directory / first)
            with patch.object(custody, "SECRET_DIR", directory):
                with self.assertRaises(OSError):
                    custody.read_passwords(expected_uid=uid)
                (directory / second).unlink()
                (directory / second).write_text("B" * 48 + "\n", encoding="ascii")
                os.chmod(directory / second, 0o644)
                with self.assertRaises(PermissionError):
                    custody.read_passwords(expected_uid=uid)
                os.chmod(directory / second, 0o600)
                os.chmod(directory, 0o755)
                with self.assertRaises(PermissionError):
                    custody.read_passwords(expected_uid=uid)

    def test_missing_approval_prevents_any_provider_login_activity(self):
        for argument in ([], ["--apply"], ["unknown"]):
            with patch.dict(os.environ, {custody.APPROVAL: ""}), patch.object(
                custody, "preflight", side_effect=AssertionError("no database")
            ):
                with self.assertRaises((ValueError, RuntimeError)):
                    custody.main(argument)

    def test_read_only_preflight_requires_exact_0043_ledger_and_disabled_providers(self):
        versions = [f"{index:04d}_ci_name" for index in range(1, 44)]
        versions[-1] = "0043_claimed_provider_secret_scope"
        fields = "vns|videonews|170006|scram-sha-256|2|0|0|0|0|0|0|0|1"
        sql = []
        with patch.object(custody, "check_operator"), patch.object(
            custody, "expected_versions", return_value=versions
        ), patch.object(custody, "read_passwords", return_value=["A" * 48, "B" * 48]), patch.object(
            custody, "owner_sql", side_effect=lambda statement, read_only=True:
                (sql.append((statement, read_only)),
                 fields if "current_user" in statement else (
                    "t" if "has_function_privilege" in statement else "\n".join(versions)))[1]
        ):
            custody.preflight()
            self.assertEqual(len(sql), 3)
            self.assertTrue(all(only_read for _, only_read in sql))
        with patch.object(custody, "check_operator"), patch.object(
            custody, "expected_versions", return_value=versions
        ), patch.object(custody, "owner_sql", return_value=fields.replace("|2|0|", "|1|0|", 1)):
            with self.assertRaises(RuntimeError):
                custody.preflight()
        def insufficient_acl(statement, read_only=True):
            if "current_user" in statement:
                return fields
            if "has_function_privilege" in statement:
                return "f"
            return "\n".join(versions)
        with patch.object(custody, "check_operator"), patch.object(
            custody, "expected_versions", return_value=versions
        ), patch.object(custody, "owner_sql", side_effect=insufficient_acl):
            with self.assertRaises(RuntimeError):
                custody.preflight()

    def test_explicit_apply_still_demands_verified_immutable_baseline(self):
        writes = []
        with patch.dict(os.environ, {custody.APPROVAL: "PROVISION_LOGINS_ONLY"}), patch.object(
            custody, "preflight"
        ), patch.object(custody, "read_passwords", return_value=["A" * 48, "B" * 48]), patch.object(
            custody, "owner_sql", side_effect=lambda s, read_only=True:
                (writes.append((s, read_only)), "2|2|2")[1]
        ):
            custody.main(["--apply"])
        self.assertEqual(len(writes), 2)
        self.assertFalse(writes[0][1])
        self.assertTrue(writes[1][1])
        self.assertIn("CREATE ROLE", writes[0][0])
        self.assertNotIn("CREATE ROLE", writes[1][0])


if __name__ == "__main__":
    unittest.main()
