import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import p1_09_provider_writer_custody as module


class ProviderWriterCustodyTests(unittest.TestCase):
    def test_only_dedicated_login_and_scram_verifier(self):
        password = "A" * 48
        statement = module.grant_sql(password)
        self.assertIn("CREATE ROLE vns_provider_config_login LOGIN INHERIT", statement)
        self.assertIn("GRANT vns_provider_config_writer TO vns_provider_config_login", statement)
        self.assertIn("NOSUPERUSER NOCREATEDB NOCREATEROLE", statement)
        self.assertIn("BEGIN;", statement)
        self.assertIn("COMMIT;", statement)
        self.assertNotIn(password, statement)
        self.assertIn("SCRAM-SHA-256$4096:", statement)
        self.assertNotIn("GRANT vns_provider_config_executor TO", statement)

    def test_exact_target_and_runtime_role_preflight(self):
        exact = "vns|videonews|170007|18|0018_ai_provider_named_audit|1|1|0|2|0|0|0|1"
        with patch.object(module, "owner_sql", return_value=exact), \
             patch.object(module, "secure_parent"), \
             patch.object(module, "ci_only", return_value=True), \
             patch.object(module.Path, "exists", return_value=False), \
             patch.object(module.Path, "is_symlink", return_value=False):
            module.preflight("ci-db")
        for wrong in (
            exact.replace("|18|", "|19|"),
            exact.replace("|1|1|0|2|", "|0|1|0|2|"),
            exact.replace("|1|1|0|2|", "|1|1|1|2|"),
            exact[:-1] + "0",
        ):
            with patch.object(module, "owner_sql", return_value=wrong), \
                 self.assertRaises(RuntimeError):
                module.preflight("ci-db")

    def test_private_master_key_and_password_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            secrets = Path(root) / "secrets"
            secrets.mkdir(mode=0o700)
            with patch.object(module, "ROOT", Path(root)), \
                 patch.object(module, "KEY_DIR", secrets / "vns"), \
                 patch.object(module, "KEY_PATH", secrets / "vns" / "provider-master-key"), \
                 patch.object(module, "PASSWORD_PATH", secrets / "pg_provider_admin_password"):
                credential = module.make_files()
                self.assertRegex(credential, r"^[A-Za-z0-9_-]{40,128}$")
                self.assertEqual(
                    (secrets / "pg_provider_admin_password").read_text(), credential + "\n"
                )
                self.assertEqual(
                    (secrets / "vns" / "provider-master-key").stat().st_size, 32
                )
                self.assertEqual((secrets / "vns").stat().st_mode & 0o777, 0o700)
                self.assertEqual(
                    (secrets / "vns" / "provider-master-key").stat().st_mode & 0o777, 0o600
                )
                self.assertEqual(
                    (secrets / "pg_provider_admin_password").stat().st_mode & 0o777, 0o600
                )
                with self.assertRaises(FileExistsError):
                    module.make_files()

    def test_sql_login_proof_never_places_password_in_process_args(self):
        captured = []
        def fake_run(args, payload=None):
            captured.append((args, payload))
            return "vns_provider_config_login|t|2"
        with patch.object(module, "run", side_effect=fake_run):
            module.writer_sql("ci-postgres", "P" * 48, "SELECT 1;")
        self.assertEqual(len(captured), 1)
        args, payload = captured[0]
        self.assertNotIn("P" * 48, str(args))
        self.assertIn("-h postgres", str(args))
        self.assertEqual(payload, "P" * 48 + "\nSELECT 1;")
        with self.assertRaises(RuntimeError):
            module.writer_sql("ci-postgres", "not a strong password", "SELECT 1;")


if __name__ == "__main__":
    unittest.main()
