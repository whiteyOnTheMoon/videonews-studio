"""Offline safety tests for P2-02 three-personal-service PostgreSQL LOGIN custody."""
import contextlib
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p2_02_feed_login_custody as mod


class FeedLoginCustodyTests(unittest.TestCase):
    def test_fixed_roles_and_no_runtime_activation(self):
        self.assertEqual([row[0] for row in mod.SERVICES], [
            "vns_source_export_login_prod",
            "vns_feed_login_prod",
            "vns_feed_project_login_prod",
        ])
        self.assertEqual([row[1] for row in mod.SERVICES], [
            "vns_source_export_reader",
            "vns_feed_poll_writer",
            "vns_feed_project_client",
        ])
        self.assertIn("0061_single_owner_review_policy", mod.PREFLIGHT_SQL)
        self.assertIn("count(*) FROM vns.schema_migrations)=61", mod.PREFLIGHT_SQL)
        self.assertIn("pg_hba_file_rules", mod.PREFLIGHT_SQL)
        self.assertNotIn("CREATE ROLE", mod.PREFLIGHT_SQL)

    def test_scram_sql_only_derived_credentials_and_exact_memberships(self):
        passwords = ["a" * 64, "b" * 64, "c" * 64]
        sql = mod.build_transaction(passwords, [bytes([i + 1]) * 16 for i in range(3)])
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertTrue(sql.rstrip().endswith("COMMIT;"))
        self.assertEqual(sql.count("CREATE ROLE"), 3)
        self.assertEqual(sql.count(" WITH INHERIT TRUE, SET FALSE;"), 3)
        self.assertIn("IF NOT (", sql)
        self.assertIn("feed login enrollment refused", sql)
        for login, group, _ in mod.SERVICES:
            self.assertIn(f'CREATE ROLE "{login}" LOGIN INHERIT', sql)
            self.assertIn(f'GRANT "{group}" TO "{login}" WITH INHERIT TRUE, SET FALSE;', sql)
        for password in passwords:
            self.assertNotIn(password, sql)
        for bad in [
            (passwords[:2], [b"a" * 16] * 2),
            ([passwords[0]] * 3, [b"a" * 16] * 3),
            (passwords, [b"x" * 16] * 2),
        ]:
            with self.assertRaises(ValueError):
                mod.build_transaction(*bad)

    def test_read_private_credentials_rejects_duplicate_symlink_and_modes(self):
        with tempfile.TemporaryDirectory() as root:
            secret_dir = Path(root) / "custody"
            secret_dir.mkdir(mode=0o700)
            passwords = ["a" * 64, "b" * 64, "c" * 64]
            for (_, _, name), password in zip(mod.SERVICES, passwords):
                file = secret_dir / name
                file.write_text(password + "\n", encoding="ascii")
                file.chmod(0o600)
            with patch.object(mod, "SECRET_DIR", secret_dir):
                self.assertEqual(mod.read_secrets(expected_uid=os.geteuid()), passwords)
                (secret_dir / mod.SERVICES[2][2]).write_text(passwords[0] + "\n")
                with self.assertRaises(ValueError):
                    mod.read_secrets(expected_uid=os.geteuid())
                (secret_dir / mod.SERVICES[2][2]).write_text(passwords[2] + "\n")
                secret = secret_dir / mod.SERVICES[0][2]
                secret.chmod(0o644)
                with self.assertRaises(PermissionError):
                    mod.read_secrets(expected_uid=os.geteuid())
                secret.chmod(0o600)
                secret.rename(secret_dir / "target")
                secret.symlink_to(secret_dir / "target")
                with self.assertRaises(OSError):
                    mod.read_secrets(expected_uid=os.geteuid())

    def test_staging_only_writes_exclusive_owner_private_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "secrets").mkdir(mode=0o700)
            actual = mod.open_private_dir
            with (
                patch.object(mod, "ROOT", root),
                patch.object(mod, "SECRET_DIR", root / "secrets" / "p2-feed-login-custody"),
                patch.object(mod, "check_release"),
                patch.object(mod, "check_db"),
                patch.object(mod, "open_private_dir",
                             side_effect=lambda path, **kw: actual(path, expected_uid=os.geteuid())),
            ):
                mod.stage_secrets("a" * 40)
                self.assertEqual(
                    sorted(p.name for p in mod.SECRET_DIR.iterdir()),
                    sorted(row[2] for row in mod.SERVICES),
                )
                self.assertEqual(stat.S_IMODE(mod.SECRET_DIR.stat().st_mode), 0o700)
                for p in mod.SECRET_DIR.iterdir():
                    self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
                    self.assertGreaterEqual(p.stat().st_size, 41)
                with self.assertRaises(FileExistsError):
                    mod.stage_secrets("a" * 40)

    def test_apply_requires_opt_in_and_never_calls_sql_without_gate(self):
        with patch.dict(mod.os.environ, {mod.APPROVAL: ""}):
            with patch.object(mod, "preflight") as preflight:
                with self.assertRaises(PermissionError):
                    mod.apply("a" * 40)
                preflight.assert_not_called()

    def test_apply_one_transaction_with_postcheck_and_no_plaintext_output(self):
        creds = ["a" * 64, "b" * 64, "c" * 64]
        with (
            patch.dict(mod.os.environ, {mod.APPROVAL: mod.REQUIRED_APPROVAL}),
            patch.object(mod, "preflight"),
            patch.object(mod, "read_secrets", return_value=creds),
            patch.object(mod.os, "urandom", return_value=b"s" * 16),
            patch.object(mod, "psql", side_effect=["", "3|3|3|t"]) as psql,
            contextlib.redirect_stdout(io.StringIO()) as captured,
        ):
            mod.apply("a" * 40)
            self.assertEqual(psql.call_count, 2)
            self.assertEqual(psql.call_args_list[0].kwargs, {"read_only": False})
            self.assertEqual(psql.call_args_list[1].kwargs, {})
            for password in creds:
                self.assertNotIn(password, psql.call_args_list[0].args[0])
                self.assertNotIn(password, captured.getvalue())

    def test_postcheck_refusal_is_not_silently_retried(self):
        with (
            patch.dict(mod.os.environ, {mod.APPROVAL: mod.REQUIRED_APPROVAL}),
            patch.object(mod, "preflight"),
            patch.object(mod, "read_secrets", return_value=["a"*64,"b"*64,"c"*64]),
            patch.object(mod.os, "urandom", return_value=b"s"*16),
            patch.object(mod, "psql", side_effect=["", "3|3|4|t"]) as psql,
        ):
            with self.assertRaises(RuntimeError):
                mod.apply("a"*40)
            self.assertEqual(psql.call_count, 2)

    def test_cli_has_no_implicit_apply(self):
        with patch.object(mod, "stage_secrets") as stage, patch.object(mod, "apply") as apply:
            with self.assertRaises(SystemExit):
                mod.main(["--expected-sha", "a"*40])
            stage.assert_not_called()
            apply.assert_not_called()


if __name__ == "__main__":
    unittest.main()
