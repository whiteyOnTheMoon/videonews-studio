"""Offline tests for the guarded P2-A 0048->0059 production schema upgrade."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import p2_a_schema_0048_to_0059 as m


class P2A0059Schema(unittest.TestCase):
    def test_manifest_exact_and_symlinks_rejected(self):
        names = m.expected_versions()
        self.assertEqual(len(names), 59)
        self.assertEqual(names[47], "0048_provider_outbox_delivery_receipt")
        self.assertEqual(names[48], "0049_approved_feed_rankings")
        self.assertEqual(names[-1], "0059_canonical_event_title_fingerprint")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in names:
                (root / (name + ".up.sql")).write_text(
                    "-- synthetic fixture " + "x" * 120 +
                    "\nBEGIN;\nSELECT 1;\nCOMMIT;\n", encoding="utf-8"
                )
            with patch.object(m, "MIGRATIONS", root):
                self.assertEqual(m.expected_versions(), names)
                path = root / (names[-1] + ".up.sql")
                path.unlink()
                path.symlink_to(root / (names[-2] + ".up.sql"))
                with self.assertRaises(RuntimeError):
                    m.expected_versions()
                path.unlink()
                (root / (names[-1] + ".up.sql")).write_text("BEGIN; SELECT 1; COMMIT;")
                with self.assertRaises(RuntimeError):
                    m.expected_versions()

    def test_preflight_exact_0048_superuser_pg17_and_no_existing_p2_objects(self):
        names = m.expected_versions()
        state = "vns|videonews|on|170006|0|0|0|0"
        snapshot = "1:" + "a" * 32 + "|0:" + "b" * 32 + "|0:" + "c" * 32
        def query(_name, sql, **_kwargs):
            if sql == m.SAFETY_SQL:
                return state
            if sql == m.ABSENCE_SQL:
                return "t"
            if sql == m.UNCHANGED_SQL:
                return snapshot
            raise AssertionError("Unknown SQL requested")
        with patch.object(m, "ledger", return_value=names[:48]), patch.object(
            m, "query", side_effect=query
        ), patch.object(m, "resources"):
            self.assertEqual(m.preflight(m.CONTAINER, names), snapshot)
        unsafe = [
            "vns|videonews|off|170006|0|0|0|0",
            "vns|videonews|on|160006|0|0|0|0",
            "vns|videonews|on|170006|1|0|0|0",
            "vns|videonews|on|170006|0|1|0|0",
            "vns|videonews|on|170006|0|0|1|0",
        ]
        for value in unsafe:
            with patch.object(m, "ledger", return_value=names[:48]), patch.object(
                m, "query", side_effect=lambda _n, sql: value if sql == m.SAFETY_SQL else "t"
            ), patch.object(m, "resources"):
                with self.assertRaises(RuntimeError):
                    m.preflight(m.CONTAINER, names)
        with patch.object(m, "ledger", return_value=names[:49]):
            with self.assertRaises(RuntimeError):
                m.preflight(m.CONTAINER, names)
        with patch.object(m, "ledger", return_value=names[:48]), patch.object(
            m, "query", side_effect=lambda _n, sql: state if sql == m.SAFETY_SQL else "f"
        ), patch.object(m, "resources"):
            with self.assertRaises(RuntimeError):
                m.preflight(m.CONTAINER, names)

    def test_operator_approval_and_exact_sha_checked_before_any_db_probe(self):
        names = m.expected_versions()
        for approval, sha in [
            (None, None),
            ("APPLY_ADDITIVE_0049_0059", "b" * 40),
            ("APPLY_ALL", "a" * 40),
        ]:
            env = {}
            if approval is not None:
                env[m.APPROVAL] = approval
            if sha is not None:
                env[m.SHA_APPROVAL] = sha
            with patch.dict("os.environ", env, clear=True), patch.object(
                m, "git_sha", return_value="a" * 40
            ), patch.object(m, "expected_versions", return_value=names), patch.object(
                m, "container", side_effect=AssertionError("No DB before ACK")
            ):
                with self.assertRaises(RuntimeError):
                    m.main(["--apply"])

    def test_sequential_schema_ledger_verified_before_and_after_each_commit(self):
        names = m.expected_versions()
        installed = names[:48].copy()
        count = 0
        def execute(_name, sql, readonly=True, timeout=40):
            nonlocal count
            self.assertFalse(readonly)
            self.assertEqual(timeout, 140)
            self.assertIn("BEGIN;", sql)
            self.assertTrue(sql.rstrip().endswith("COMMIT;"))
            count += 1
            installed.append(names[len(installed)])
            return ""
        with patch.object(m, "ledger", side_effect=lambda _name: installed.copy()), patch.object(
            m, "query", side_effect=execute
        ), patch.object(m, "final_check") as final:
            m.apply(m.CONTAINER, names, "snapshot")
            final.assert_called_once()
        self.assertEqual(count, 11)

    def test_partial_migration_never_retries_or_runs_down_migration(self):
        names = m.expected_versions()
        installed = names[:48].copy()
        def broken(_name, sql, readonly=True, timeout=40):
            if len(installed) == 50:
                raise RuntimeError("Ambiguous query outcome")
            installed.append(names[len(installed)])
            return ""
        with patch.object(m, "ledger", side_effect=lambda _name: installed.copy()), patch.object(
            m, "query", side_effect=broken
        ), patch.object(m, "final_check", side_effect=AssertionError("Not reached")):
            with self.assertRaises(RuntimeError):
                m.apply(m.CONTAINER, names, "snapshot")
        self.assertEqual(len(installed), 50)
        with patch.object(m, "ledger", return_value=installed):
            with self.assertRaises(RuntimeError):
                m.preflight(m.CONTAINER, names)

    def test_final_acl_review_and_registry_snapshot_assertions(self):
        names = m.expected_versions()
        snapshot = "0:" + "1" * 32 + "|0:" + "2" * 32 + "|0:" + "3" * 32
        def data(_name, sql):
            if sql == m.UNCHANGED_SQL:
                return snapshot
            if sql == m.FINAL_SQL:
                return "0|0|0|0|true|false|true"
            if sql == m.SAFETY_SQL:
                return "vns|videonews|on|170006|0|0|0|0"
            raise AssertionError("Unexpected query")
        with patch.object(m, "ledger", return_value=names), patch.object(
            m, "query", side_effect=data
        ):
            m.final_check(m.CONTAINER, names, snapshot)
        for wrong in ("0|0|0|0|true|true|true", "0|0|0|1|true|false|true"):
            with patch.object(m, "ledger", return_value=names), patch.object(
                m, "query", side_effect=lambda _n, sql: wrong if sql == m.FINAL_SQL else
                snapshot if sql == m.UNCHANGED_SQL else "vns|videonews|on|170006|0|0|0|0"
            ):
                with self.assertRaises(RuntimeError):
                    m.final_check(m.CONTAINER, names, snapshot)
        with patch.object(m, "ledger", return_value=names), patch.object(
            m, "query", side_effect=lambda _n, sql: "changed" if sql == m.UNCHANGED_SQL else
            "0|0|0|0|true|false|true"
        ):
            with self.assertRaises(RuntimeError):
                m.final_check(m.CONTAINER, names, snapshot)

    def test_redacted_shell_failure_no_stdout_stderr(self):
        sample = subprocess.CompletedProcess(
            args=["irrelevant"], returncode=1, stdout="private audit rows",
            stderr="password=secret",
        )
        with patch.object(m.subprocess, "run", return_value=sample):
            with self.assertRaises(RuntimeError) as result:
                m.command(["false"])
            self.assertEqual(str(result.exception), m.FAIL)
        with patch.object(m, "command", return_value="not a healthy project container"):
            with self.assertRaises(RuntimeError):
                m.container()
        with self.assertRaises(RuntimeError):
            m.query("other-postgres-1", "SELECT 1;")

    def test_reject_wrong_user_dirty_git_branch_and_sha(self):
        with patch.object(m.os, "geteuid", return_value=0):
            with self.assertRaises(RuntimeError):
                m.git_sha()
        with patch.object(m.os, "geteuid", return_value=1000), patch.object(
            m, "command", return_value="feature-branch"
        ):
            with self.assertRaises(RuntimeError):
                m.git_sha()


if __name__ == "__main__":
    unittest.main()
