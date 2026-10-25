import contextlib
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import provision_pg_runtime_logins as mod


class PgLoginProvisioningTests(unittest.TestCase):
    def make_secrets(self, root, mode=0o600):
        folder = Path(root) / "secrets"
        folder.mkdir(mode=0o700)
        passwords = ["a" * 64, "b" * 64, "c" * 64]
        for (_, _, filename), password in zip(mod.SERVICES, passwords):
            path = folder / filename
            path.write_text(password + "\n", encoding="ascii")
            path.chmod(mode)
        return folder, passwords

    def test_reads_three_private_secrets_and_refuses_duplicates(self):
        with tempfile.TemporaryDirectory() as root:
            folder, passwords = self.make_secrets(root)
            self.assertEqual(mod.read_passwords(folder, expected_uid=os.geteuid()), passwords)
            (folder / mod.SERVICES[2][2]).write_text(passwords[0] + "\n")
            with self.assertRaises(ValueError):
                mod.read_passwords(folder, expected_uid=os.geteuid())

    def test_rejects_unsafe_secret_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            folder, _ = self.make_secrets(root)
            (folder / mod.SERVICES[0][2]).chmod(0o644)
            with self.assertRaises(PermissionError):
                mod.read_passwords(folder, expected_uid=os.geteuid())
            (folder / mod.SERVICES[0][2]).chmod(0o600)
            folder.chmod(0o755)
            with self.assertRaises(PermissionError):
                mod.read_passwords(folder, expected_uid=os.geteuid())

    def test_rejects_symlinked_file_and_directory(self):
        with tempfile.TemporaryDirectory() as root:
            folder, _ = self.make_secrets(root)
            original = folder / mod.SERVICES[0][2]
            original.rename(folder / "other")
            original.symlink_to(folder / "other")
            with self.assertRaises(OSError):
                mod.read_passwords(folder, expected_uid=os.geteuid())
            link = Path(root) / "link"
            link.symlink_to(folder, target_is_directory=True)
            with self.assertRaises(OSError):
                mod.read_passwords(link, expected_uid=os.geteuid())

    def test_scram_derived_verifier_never_embeds_password(self):
        password = "very-private-runtime-test-credential-" + "a" * 40
        salt = b"1" * 16
        verifier = mod.scram_verifier(password, salt)
        self.assertTrue(verifier.startswith("SCRAM-SHA-256$4096:"))
        self.assertEqual(len(verifier.split("$")), 3)
        self.assertNotIn(password, verifier)
        self.assertEqual(verifier, mod.scram_verifier(password, salt))
        self.assertNotEqual(verifier, mod.scram_verifier(password, b"2" * 16))

    def test_transaction_is_atomic_and_only_fixed_roles(self):
        passwords = ["a" * 64, "b" * 64, "c" * 64]
        sql = mod.build_transaction(passwords, [bytes([i]) * 16 for i in range(3)])
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertTrue(sql.rstrip().endswith("COMMIT;"))
        self.assertEqual(sql.count("CREATE ROLE"), 3)
        self.assertEqual(sql.count("GRANT "), 3)
        self.assertIn("RAISE EXCEPTION 'runtime login provisioning preflight rejected'", sql)
        self.assertIn("NOSUPERUSER NOCREATEDB", sql)
        self.assertIn("NOCREATEROLE NOREPLICATION NOBYPASSRLS", sql)
        for login, group, _ in mod.SERVICES:
            self.assertIn(f'GRANT "{group}" TO "{login}";', sql)
        for password in passwords:
            self.assertNotIn(password, sql)
        for secret_name in ("postgres_password", "redis_acl"):
            self.assertNotIn("file: " + secret_name, sql)

    def test_preflight_checks_expected_db_state(self):
        with patch.object(mod, "command", side_effect=[
            "main", "", "videonews-studio|postgres|healthy"
        ]) as command, patch.object(mod, "psql", return_value="vns|12|3|0|0|1|scram-sha-256") as psql:
            mod.preflight()
            self.assertEqual(command.call_count, 3)
            psql.assert_called_once_with(mod.PREFLIGHT, read_only=True)
        with patch.object(mod, "command", side_effect=[
            "main", "", "videonews-studio|postgres|healthy"
        ]), patch.object(mod, "psql", return_value="vns|12|2|0|0|1|scram-sha-256"):
            with self.assertRaises(RuntimeError):
                mod.preflight()

    def test_apply_requires_explicit_switch_and_suppresses_credentials(self):
        with patch.object(mod.sys, "argv", ["provision_pg_runtime_logins.py"]):
            with self.assertRaises(RuntimeError):
                mod.main()
        with tempfile.TemporaryDirectory() as root:
            mod_reader = mod.read_passwords
            _, passwords = self.make_secrets(root)
            output = io.StringIO()
            with (
                patch.object(mod, "ROOT", Path(root)),
                patch.object(mod, "read_passwords", side_effect=lambda directory: mod_reader(directory, expected_uid=os.geteuid())),
                patch.object(mod.sys, "argv", ["provision_pg_runtime_logins.py", "--apply"]),
                patch.object(mod, "preflight"),
                patch.object(mod.os, "urandom", return_value=b"x" * 16),
                patch.object(mod, "psql", side_effect=["", "3|3|3"]) as psql,
                contextlib.redirect_stdout(output),
            ):
                mod.main()
                self.assertEqual(psql.call_count, 2)
                self.assertFalse(psql.call_args_list[0].kwargs["read_only"])
                self.assertTrue(psql.call_args_list[1].kwargs["read_only"])
                for password in passwords:
                    self.assertNotIn(password, psql.call_args_list[0].args[0])
            for password in passwords:
                self.assertNotIn(password, output.getvalue())

    def test_failure_does_not_retry_or_change_staged_files(self):
        with tempfile.TemporaryDirectory() as root:
            mod_reader = mod.read_passwords
            folder, _ = self.make_secrets(root)
            before = {path.name: path.read_bytes() for path in folder.iterdir()}
            with (
                patch.object(mod, "ROOT", Path(root)),
                patch.object(mod, "read_passwords", side_effect=lambda directory: mod_reader(directory, expected_uid=os.geteuid())),
                patch.object(mod.sys, "argv", ["provision_pg_runtime_logins.py", "--apply"]),
                patch.object(mod, "preflight", side_effect=RuntimeError("blocked")),
                patch.object(mod, "psql") as psql,
            ):
                with self.assertRaises(RuntimeError):
                    mod.main()
                psql.assert_not_called()
            self.assertEqual(before, {p.name: p.read_bytes() for p in folder.iterdir()})


if __name__ == "__main__":
    unittest.main()
