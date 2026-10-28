#!/usr/bin/env python3
"""No-network unit coverage for the controlled P1-09 schema transition."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import p1_09_schema_0018_to_0043 as upgrade


class ProviderSchema0043Tests(unittest.TestCase):
    def test_exact_tracked_migration_files(self):
        versions = upgrade.filenames()
        self.assertEqual(len(versions), 43)
        self.assertEqual(versions[17], "0018_ai_provider_named_audit")
        self.assertEqual(versions[-1], "0043_claimed_provider_secret_scope")
        self.assertEqual([int(n[:4]) for n in versions], list(range(1, 44)))

    def test_unknown_versions_or_symlink_migration_refused(self):
        with tempfile.TemporaryDirectory(prefix="vns-p109-schema-") as temp:
            directory = Path(temp)
            for i in range(1, 44):
                path = directory / f"{i:04d}_ci_migration.up.sql"
                path.write_text("-- CI only\nBEGIN; COMMIT;\n", encoding="utf8")
            with patch.object(upgrade, "MIGRATIONS", directory):
                with self.assertRaises(RuntimeError):
                    upgrade.filenames()  # exact migration suffixes required
            for file in directory.glob("*.up.sql"):
                file.unlink()
            versions = upgrade.filenames()
            for name in versions:
                (directory / (name + ".up.sql")).write_text(
                    "-- disposable CI\nBEGIN; COMMIT;\n", encoding="utf8"
                )
            with patch.object(upgrade, "MIGRATIONS", directory):
                self.assertEqual(upgrade.filenames(), versions)
                target = directory / (versions[-1] + ".up.sql")
                target.unlink()
                target.symlink_to(directory / (versions[-2] + ".up.sql"))
                with self.assertRaises(RuntimeError):
                    upgrade.filenames()

    def test_exact_0018_baseline_rejects_new_roles_activated_providers_and_drift(self):
        versions = upgrade.filenames()
        state = "vns|videonews|on|170006|0|0|0|0|0"
        with patch.object(upgrade, "ledger", return_value=versions[:18]), patch.object(
            upgrade, "query",
            side_effect=lambda _container, sql:
                state if "current_user" in sql else "t",
        ), patch.object(upgrade, "check_resources"):
            upgrade.check_0018_baseline("ci-only", versions, True)
        for bad in (
            "vns|videonews|off|170006|0|0|0|0|0",
            "vns|videonews|on|170006|1|0|0|0|0",
            "vns|videonews|on|170006|0|1|0|0|0",
            "vns|videonews|on|170006|0|0|2|0|0",
            "vns|videonews|on|170006|0|0|0|0|1",
        ):
            with patch.object(upgrade, "ledger", return_value=versions[:18]), patch.object(
                upgrade, "query",
                side_effect=lambda _container, sql:
                    bad if "current_user" in sql else "t",
            ), patch.object(upgrade, "check_resources"):
                with self.assertRaises(RuntimeError):
                    upgrade.check_0018_baseline("ci-only", versions, True)
        with patch.object(upgrade, "ledger", return_value=versions[:19]):
            with self.assertRaises(RuntimeError):
                upgrade.check_0018_baseline("ci-only", versions, True)

    def test_default_off_and_sha_pin_prevent_unapproved_apply(self):
        with patch.object(upgrade, "ci_fixture", return_value=False), patch.object(
            upgrade, "git_state", return_value="a" * 40
        ), patch.object(upgrade, "container_name", return_value="ci-only"), patch.object(
            upgrade, "filenames", return_value=upgrade.filenames()
        ), patch.object(upgrade, "check_0018_baseline",
                        side_effect=AssertionError("no SQL preflight yet")):
            with patch.dict("os.environ", {}, clear=True):
                with self.assertRaises(RuntimeError):
                    upgrade.main(["--apply"])
            with patch.dict("os.environ", {
                upgrade.APPROVAL: "APPLY_ADDITIVE_0019_0043",
                upgrade.SHA_APPROVAL: "b" * 40,
            }):
                with self.assertRaises(RuntimeError):
                    upgrade.main(["--apply"])

    def test_apply_is_sequential_and_stops_on_uncertain_commit(self):
        versions = upgrade.filenames()
        current = versions[:18].copy()
        changes = []
        def run_sql(_container, sql, readonly=True, timeout=40):
            self.assertFalse(readonly)
            self.assertEqual(timeout, 140)
            self.assertIn("BEGIN;", sql)
            self.assertIn("COMMIT;", sql)
            changes.append(sql)
            current.append(versions[len(current)])
            return ""
        with patch.object(upgrade, "ledger", side_effect=lambda _container: current.copy()), patch.object(
            upgrade, "query", side_effect=run_sql
        ), patch.object(upgrade, "final_state", return_value=None):
            upgrade.apply("ci-only", versions)
        self.assertEqual(len(changes), 25)
        current = versions[:18].copy()
        def error_midway(_container, sql, readonly=True, timeout=40):
            if len(current) >= 20:
                raise RuntimeError("simulated interruption")
            current.append(versions[len(current)])
            return ""
        with patch.object(upgrade, "ledger", side_effect=lambda _container: current.copy()), patch.object(
            upgrade, "query", side_effect=error_midway
        ), patch.object(upgrade, "final_state", side_effect=AssertionError("cannot finish")):
            with self.assertRaises(RuntimeError):
                upgrade.apply("ci-only", versions)
        self.assertEqual(len(current), 20)

    def test_command_errors_never_echo_credentials_or_server_diagnostics(self):
        fake = subprocess.CompletedProcess(
            args=["test"], returncode=1,
            stdout="SCRAM-SHA-256$private", stderr="SERVER SECRET LEAK",
        )
        with patch.object(upgrade.subprocess, "run", return_value=fake):
            with self.assertRaises(RuntimeError) as cm:
                upgrade.command(["false"])
        self.assertEqual(str(cm.exception), upgrade.FAIL)
        self.assertNotIn("private", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
