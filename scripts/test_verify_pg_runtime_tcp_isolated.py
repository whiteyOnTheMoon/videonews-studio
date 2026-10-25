import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import verify_pg_runtime_tcp_isolated as mod


class IsolatedPgTcpTest(unittest.TestCase):
    def make_files(self, root):
        directory = Path(root) / "secrets"
        directory.mkdir(mode=0o700)
        for entry in mod.SERVICES:
            file = directory / entry[2]
            file.write_text("CI-placeholder-not-used\n")
            file.chmod(0o600)
        return directory

    def test_refuses_unsafe_directory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = self.make_files(root)
            directory.chmod(0o755)
            with patch.object(mod.os, "geteuid", return_value=1000):
                with self.assertRaises(PermissionError):
                    mod.inspect_local_secret_paths(directory)

    def test_refuses_symlink_directory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = self.make_files(root)
            link = Path(root) / "other"
            link.symlink_to(directory, target_is_directory=True)
            with self.assertRaises((OSError, PermissionError)):
                mod.inspect_local_secret_paths(link)

    def test_requires_explicit_operator_action(self):
        with patch.object(mod.sys, "argv", ["verify_pg_runtime_tcp_isolated.py"]):
            with self.assertRaises(RuntimeError):
                mod.main()

    def test_preflight_checks_private_network_and_existing_postgres(self):
        with patch.object(mod, "safe_run", side_effect=[
            "main", "", "true",
            "videonews-studio|postgres|healthy|sha256:ci-only", "", "[]",
        ]) as run:
            self.assertEqual(mod.preflight(), "sha256:ci-only")
            self.assertEqual(run.call_count, 6)
        with patch.object(mod, "safe_run", side_effect=["main", "", "false"]):
            with self.assertRaises(RuntimeError):
                mod.preflight()

    def test_one_secret_per_test_container_and_no_service_mutation(self):
        seen = []
        def capture(args, timeout=20):
            seen.append(args)
            return "PASS"
        with patch.object(mod, "safe_run", side_effect=capture):
            for entry in mod.SERVICES:
                own = Path("/private") / entry[2]
                mod.test_service("sha256:ci-image", entry, own)

        self.assertEqual(len(seen), 3)
        for args, entry in zip(seen, mod.SERVICES):
            cmd = " ".join(args)
            self.assertEqual(args[:3], ["docker", "run", "--rm"])
            self.assertIn("--pull=never", args)
            self.assertIn("--network", args)
            self.assertIn(mod.BACKEND, args)
            self.assertIn("--read-only", args)
            self.assertIn("--cap-drop=ALL", args)
            self.assertIn("no-new-privileges", args)
            self.assertIn("--memory-swap", args)
            self.assertIn("--user", args)
            self.assertIn("--mount", args)
            self.assertIn(f"src=/private/{entry[2]}", cmd)
            self.assertEqual(cmd.count("src=/private/"), 1)
            self.assertIn("readonly", cmd)
            self.assertNotIn("docker compose", cmd)
            self.assertNotIn("--privileged", args)
            self.assertNotIn("--publish", args)
            self.assertNotIn("-p", args)
            self.assertNotIn("password=CI-", cmd)

    def test_shell_checks_read_only_credentials_without_echoing_them(self):
        source = mod.CLIENT_SCRIPT
        self.assertIn("default_transaction_read_only=on", source)
        self.assertIn("inet_client_addr()", source)
        self.assertIn("has_column_privilege", source)
        self.assertIn("'42501'", source)
        self.assertIn("password authentication failed", source)
        self.assertIn("/run/secrets/own_pg_password", source)
        self.assertIn("PGPASSFILE=/tmp/pgpass", source)
        self.assertNotIn("PGPASSWORD=", source)
        self.assertNotIn("INSERT INTO", source)
        self.assertNotIn("DELETE FROM", source)

    def test_boolean_scope_receipt_uses_stable_text(self):
        source = mod.CLIENT_SCRIPT
        # concat_ws formats booleans through PostgreSQL output rules.
        # Force unambiguous true/false strings instead of t/f ambiguity.
        self.assertIn(
            "CASE WHEN pg_has_role(current_user, '$GROUP', 'USAGE') "
            "THEN 'true' ELSE 'false' END", source
        )
        for expected in (
            "CASE WHEN pg_has_role(current_user, 'vns', 'MEMBER')",
            "CASE WHEN has_column_privilege(current_user, 'vns.jobs', 'status', 'UPDATE')",
            "CASE WHEN has_column_privilege(current_user, 'vns.job_outbox', 'delivery_state', 'UPDATE')",
            "CASE WHEN has_table_privilege(current_user, 'vns.research_evidence', 'INSERT')",
            "CASE WHEN has_column_privilege(current_user, 'vns.research_evidence', 'review_status', 'UPDATE')",
            "CASE WHEN has_schema_privilege(current_user, 'vns', 'CREATE')",
        ):
            self.assertIn(expected, source)

    def test_redacted_failure_stage_is_only_whitelisted(self):
        from types import SimpleNamespace
        with patch.object(mod.subprocess, "run", return_value=SimpleNamespace(
            returncode=2,
            stderr="VNS_CHECK_ALLOWED\\nconfidential-internal-diagnostics",
            stdout="confidential-secret-data",
        )):
            with self.assertRaisesRegex(RuntimeError, "guarded check failed at ALLOWED") as error:
                mod.safe_run(["docker", "run", "--rm", "something"])
            self.assertNotIn("confidential", str(error.exception))

        with patch.object(mod.subprocess, "run", return_value=SimpleNamespace(
            returncode=125,
            stderr="sensitive mount details",
            stdout="sensitive data",
        )):
            with self.assertRaisesRegex(RuntimeError, "guarded check failed at CLIENT_START") as error:
                mod.safe_run(["docker", "run", "--rm", "something"])
            self.assertNotIn("sensitive", str(error.exception))

    def test_shell_code_syntax(self):
        res = subprocess.run(
            ["/bin/sh", "-n"], input=mod.CLIENT_SCRIPT,
            capture_output=True, text=True, check=False, timeout=5,
        )
        self.assertEqual(res.returncode, 0, "operator test shell invalid")

    def test_no_true_result_from_failed_diagnostic(self):
        with patch.object(mod, "safe_run", return_value="WRONG"):
            with self.assertRaises(RuntimeError):
                mod.test_service("sha256:ci-image", mod.SERVICES[0], Path("/tmp/secret"))


if __name__ == "__main__":
    unittest.main()
