import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import p1_09_first_personal_admin as admin


class FirstOperatorTests(unittest.TestCase):
    def test_roles_use_only_scram_verifiers_and_no_shared_login(self):
        values = ("a" * 48, "b" * 48, "c" * 48)
        script = admin.role_transaction(values)
        self.assertTrue(script.startswith("BEGIN;"))
        self.assertTrue(script.rstrip().endswith("COMMIT;"))
        self.assertEqual(script.count("CREATE ROLE"), 2)
        self.assertEqual(script.count("GRANT vns_"), 2)
        for value in values:
            self.assertNotIn(value, script)
        for role in (admin.GOVERNOR, admin.PROVISIONER):
            self.assertIn(role, script)
        self.assertIn("NOSUPERUSER NOCREATEDB", script)
        self.assertNotIn("GRANT vns_api_runtime", script)

    def test_personal_operator_is_authenticated_for_audit(self):
        registry = admin.registry_transaction("b274db39-cfd5-46bf-8438-27557b89201a")
        assert "SET LOCAL ROLE vns_operator_governor" in registry
        assert "session_user <> 'vns_owner_governance_login'" in registry
        assert "register_editor_operator" in registry
        account = admin.account_transaction("ci-not-a-real-admin-password-123456")
        self.assertIn("session_user <> 'vns_owner_provision_login'", account)
        self.assertIn("SET LOCAL ROLE vns_editor_provisioner", account)
        self.assertIn("UPDATE vns.editor_accounts SET active=true", account)
        self.assertRegex(account, r"scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}")
        self.assertNotIn("ci-not-a-real-admin-password", account)

    def test_secrets_are_private_and_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "secrets").mkdir(mode=0o700)
            with patch.object(admin, "ROOT", base):
                values = admin.new_credentials()
                self.assertEqual(len(values), 3)
                self.assertEqual(len(set(values)), 3)
                for name, value in zip(
                    ("owner_provision_password", "owner_governance_password", "owner_admin_password"),
                    values,
                ):
                    location = base / "secrets" / "p1-owner-bootstrap" / name
                    self.assertEqual(location.read_text(), value + "\n")
                    self.assertEqual(location.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    admin.new_credentials()

    def test_preflight_guards_empty_exact_migration_and_scram(self):
        valid = "vns|videonews|170007|18|0018_ai_provider_named_audit|0|0|0|2|0|1"
        with patch.object(admin,"sql",return_value=valid), patch.object(admin,"trusted_ci",return_value=True):
            admin.preflight("ci-container")
        for bad in (
            valid.replace("|18|","|17|"),
            valid.replace("170007","160010"),
            valid.replace("|0|0|0|2|0|1","|1|0|0|2|0|1"),
            valid[:-1] + "0",
        ):
            with patch.object(admin,"sql",return_value=bad), patch.object(admin,"trusted_ci",return_value=True):
                with self.assertRaises(RuntimeError):
                    admin.preflight("ci-container")

    def test_actor_login_password_is_stdin_only(self):
        calls = []
        def fake_run(args, *, payload=None):
            calls.append((args,payload))
            return ""
        with patch.object(admin,"run",side_effect=fake_run):
            admin.actor_sql("c",admin.GOVERNOR,"P"*48,"SELECT 1;")
        self.assertEqual(len(calls),1)
        args,payload = calls[0]
        self.assertNotIn("P"*48,repr(args))
        self.assertEqual(payload,"P"*48+"\nSELECT 1;")
        self.assertIn("-h postgres",repr(args))
        with self.assertRaises(RuntimeError):
            admin.actor_sql("c","vns","P"*48,"SELECT 1;")


if __name__ == "__main__":
    unittest.main()
