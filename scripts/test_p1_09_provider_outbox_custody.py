#!/usr/bin/env python3
"""CI only: no Docker, provider HTTP, Redis mutation or production secrets."""
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p1_09_provider_outbox_custody as custody


class OutboxCustodyTests(unittest.TestCase):
    def test_producer_directory_must_not_be_provider_api_master_key_directory(self):
        self.assertEqual(custody.DIRECTORY.name, "vns-outbox")
        self.assertNotEqual(custody.DIRECTORY, custody.ROOT / "secrets" / "vns")

    def test_role_sql_is_scram_only_with_single_limited_membership(self):
        password = "A" * 48
        sql = custody.role_sql(password, b"1" * 16)
        self.assertIn("SCRAM-SHA-256$4096:", sql)
        self.assertNotIn(password, sql)
        self.assertIn("CREATE ROLE vns_provider_outbox_login LOGIN INHERIT", sql)
        self.assertIn(
            "GRANT vns_provider_outbox_reader TO vns_provider_outbox_login "
            "WITH INHERIT TRUE, SET FALSE;",
            sql,
        )
        self.assertIn("vns.schema_migrations)<>48", sql)
        self.assertNotIn("DROP ROLE", sql)
        self.assertNotIn("ALTER ROLE", sql)
        with self.assertRaises(ValueError):
            custody.role_sql("short", b"1" * 16)

    def test_stage_never_overwrites_and_creates_only_private_files(self):
        uid = os.geteuid()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "vns"
            directory.mkdir(mode=0o700)
            with patch.object(custody, "DIRECTORY", directory), patch.object(
                custody, "run", side_effect=["main", ""]
            ):
                custody.stage(expected_uid=uid)
                password, redis, key = custody.read_files(expected_uid=uid)
            self.assertNotEqual(password, redis)
            self.assertEqual(len(key), 32)
            files = [custody.PG_FILE, custody.REDIS_FILE,
                     custody.KEY_FILE, custody.ACL_CANDIDATE]
            self.assertEqual(sorted(path.name for path in directory.iterdir()), sorted(files))
            for name in files:
                info = (directory / name).stat()
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
                self.assertEqual(info.st_uid, uid)
                self.assertEqual(info.st_nlink, 1)
            acl = (directory / custody.ACL_CANDIDATE).read_text("ascii")
            self.assertEqual(acl, custody.acl_line(redis))
            self.assertNotIn(redis, acl)
            self.assertIn("~bull:vns:vns-provider-text:*", acl)
            with patch.object(custody, "DIRECTORY", directory), patch.object(
                custody, "run", side_effect=["main", ""]
            ):
                with self.assertRaises(FileExistsError):
                    custody.stage(expected_uid=uid)
            self.assertEqual(
                (directory / custody.PG_FILE).read_text("ascii").strip(), password
            )

    def test_symlink_wrong_mode_and_acl_tampering_are_denied(self):
        uid = os.geteuid()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "vns"
            directory.mkdir(mode=0o700)
            with patch.object(custody, "DIRECTORY", directory), patch.object(
                custody, "run", side_effect=["main", ""]
            ):
                custody.stage(expected_uid=uid)
            with patch.object(custody, "DIRECTORY", directory):
                path = directory / custody.KEY_FILE
                binary = path.read_bytes()
                path.unlink()
                target = directory / "target"
                target.write_bytes(binary)
                path.symlink_to(target)
                with self.assertRaises(OSError):
                    custody.read_files(expected_uid=uid)
                path.unlink()
                target.rename(path)
                os.chmod(path, 0o644)
                with self.assertRaises(PermissionError):
                    custody.read_files(expected_uid=uid)
                os.chmod(path, 0o600)
                acl = directory / custody.ACL_CANDIDATE
                acl.write_text("user default on\n", encoding="ascii")
                with self.assertRaises(ValueError):
                    custody.read_files(expected_uid=uid)
                os.chmod(directory, 0o755)
                with self.assertRaises(PermissionError):
                    custody.read_files(expected_uid=uid)

    def test_preflight_requires_exact_schema_and_inactive_budget(self):
        versions = [f"{n:04d}_ci_name" for n in range(1, 49)]
        versions[-1] = "0048_provider_outbox_delivery_receipt"
        state = "vns|videonews|170006|scram-sha-256|1|0|0|0|0|0|true|true|false"
        calls = []
        def read(sql, read_only=True):
            calls.append(read_only)
            return state if "current_user" in sql else "\n".join(versions)
        with patch.object(custody, "check_operator"), patch.object(
            custody, "expected_versions", return_value=versions
        ), patch.object(custody, "read_files", return_value=("A" * 48, "B" * 48, b"C" * 32)), patch.object(
            custody, "owner_sql", side_effect=read
        ):
            custody.preflight()
            self.assertEqual(calls, [True, True])
        with patch.object(custody, "check_operator"), patch.object(
            custody, "expected_versions", return_value=versions
        ), patch.object(custody, "owner_sql", return_value=state.replace("|0|0|0|true|", "|1|0|0|true|")):
            with self.assertRaises(RuntimeError):
                custody.preflight()

    def test_postgres_boolean_contract_rejects_legacy_short_form_and_unsafe_privileges(self):
        versions = [f"{n:04d}_ci_name" for n in range(1, 49)]
        versions[-1] = "0048_provider_outbox_delivery_receipt"
        canonical = "vns|videonews|170006|scram-sha-256|1|0|0|0|0|0|true|true|false"
        for wrong in [
            canonical.replace("true|true|false", "t|t|f"),
            canonical.replace("true|true|false", "true|false|false"),
            canonical.replace("true|true|false", "true|true|true"),
            canonical.replace("|1|0|0|0|0|0|", "|1|1|0|0|0|0|"),
        ]:
            with patch.object(custody, "check_operator"), patch.object(
                custody, "expected_versions", return_value=versions
            ), patch.object(
                custody, "owner_sql",
                side_effect=lambda sql: wrong if "current_user" in sql else "\\n".join(versions),
            ):
                with self.assertRaises(RuntimeError):
                    custody.preflight()

    def test_apply_requires_explicit_approval_and_only_writes_login_sql(self):
        with patch.dict(os.environ, {custody.APPROVAL: ""}), patch.object(
            custody, "preflight", side_effect=AssertionError("must not touch DB")
        ):
            with self.assertRaises(RuntimeError):
                custody.main(["--apply"])
        operations = []
        with patch.dict(os.environ, {custody.APPROVAL: "CREATE_OUTBOX_LOGIN_ONLY"}), patch.object(
            custody, "preflight"
        ), patch.object(custody, "read_files", return_value=("A" * 48, "B" * 48, b"C" * 32)), patch.object(
            custody, "owner_sql", side_effect=lambda sql, read_only=True:
                (operations.append((sql, read_only)), "1|1|1")[1]
        ):
            custody.main(["--apply"])
        self.assertEqual(len(operations), 2)
        self.assertFalse(operations[0][1])
        self.assertTrue(operations[1][1])
        self.assertIn("CREATE ROLE", operations[0][0])
        self.assertNotIn("CREATE ROLE", operations[1][0])


if __name__ == "__main__":
    unittest.main()
