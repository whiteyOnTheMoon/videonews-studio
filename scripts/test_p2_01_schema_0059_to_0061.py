"""P2-01 offline tests: controlled additive 0059->0061 schema-only gate."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import p2_01_schema_0059_to_0061 as m


class SourceSchema0061(unittest.TestCase):
    def test_exact_manifest_and_symlink_denial(self):
        names = m.expected_versions()
        self.assertEqual(len(names), 61)
        self.assertEqual(names[-2:], list(m.NEW))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in names:
                (root / (name + ".up.sql")).write_text(
                    "-- synthetic fixture\nBEGIN;\nSELECT 1;\nCOMMIT;\n",
                    encoding="utf-8",
                )
            with patch.object(m, "MIGRATIONS", root), patch.object(
                m.prior, "MIGRATIONS", root
            ):
                self.assertEqual(m.expected_versions(), names)
                final = root / (names[-1] + ".up.sql")
                final.unlink()
                final.symlink_to(root / (names[-2] + ".up.sql"))
                with self.assertRaises(RuntimeError):
                    m.expected_versions()

    def test_fail_closed_preflight_and_no_source_authorization(self):
        names = m.expected_versions()
        snapshot = "0:" + "a" * 32 + "|0:" + "b" * 32 + "|0:" + "c" * 32
        def good(query):
            if query == m.prior.SAFETY_SQL:
                return "vns|videonews|on|170006|0|0|0|0"
            if query == m.prior.UNCHANGED_SQL:
                return snapshot
            if query in (m.BASELINE_SQL, m.INACTIVE_SQL):
                return "t"
            raise AssertionError("Unexpected SQL")
        with patch.object(m, "ledger", return_value=names[:59]), patch.object(
            m, "sql", side_effect=good
        ), patch.object(m.prior, "resources"):
            self.assertEqual(m.preflight(names), snapshot)
        with patch.object(m, "ledger", return_value=names[:60]):
            with self.assertRaises(RuntimeError):
                m.preflight(names)
        for false_query in (m.BASELINE_SQL, m.INACTIVE_SQL):
            with patch.object(m, "ledger", return_value=names[:59]), patch.object(
                m, "sql", side_effect=lambda sql: "f" if sql == false_query else good(sql)
            ), patch.object(m.prior, "resources"):
                with self.assertRaises(RuntimeError):
                    m.preflight(names)

    def test_explicit_ack_and_exact_main_sha_before_db(self):
        names = m.expected_versions()
        for env in (
            {},
            {m.ACK: "INSTALL_SCHEMA_ONLY_0060_0061"},
            {m.ACK: "INSTALL_SCHEMA_ONLY_0060_0061", m.SHA_ACK: "b" * 40},
        ):
            with patch.dict("os.environ", env, clear=True), patch.object(
                m.prior, "git_sha", return_value="a" * 40
            ), patch.object(m, "expected_versions", return_value=names), patch.object(
                m.prior, "container", side_effect=AssertionError("No DB before ACK")
            ):
                with self.assertRaises(RuntimeError):
                    m.main(["--apply"])

    def test_strict_forward_only_ledger_with_no_auto_resume(self):
        names = m.expected_versions()
        installed = names[:59].copy()
        def execute(query, *, readonly=True, timeout=40):
            self.assertFalse(readonly)
            self.assertEqual(timeout, 140)
            self.assertTrue(query.startswith("--"))
            self.assertTrue(query.rstrip().endswith("COMMIT;"))
            installed.append(names[len(installed)])
            return ""
        with patch.object(m, "ledger", side_effect=lambda: installed.copy()), patch.object(
            m, "sql", side_effect=execute
        ), patch.object(m, "final_check") as final:
            m.apply(names, "snapshot")
            final.assert_called_once_with(names, "snapshot")
        self.assertEqual(installed, names)

        installed = names[:59].copy()
        count = 0
        def break_on_second(_text, *, readonly=True, timeout=40):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("Ambiguous outcome")
            installed.append(names[len(installed)])
            return ""
        with patch.object(m, "ledger", side_effect=lambda: installed.copy()), patch.object(
            m, "sql", side_effect=break_on_second
        ):
            with self.assertRaises(RuntimeError):
                m.apply(names, "snapshot")
        self.assertEqual(installed, names[:60])
        with patch.object(m, "ledger", return_value=installed):
            with self.assertRaises(RuntimeError):
                m.preflight(names)

    def test_postcondition_requires_db_grants_policy_off_and_snapshot_unchanged(self):
        names = m.expected_versions()
        snapshot = "0:" + "a" * 32 + "|0:" + "b" * 32 + "|0:" + "c" * 32
        def good(query):
            if query == m.prior.UNCHANGED_SQL:
                return snapshot
            if query in (m.INACTIVE_SQL, m.FINAL_SQL):
                return "t"
            if query == m.prior.SAFETY_SQL:
                return "vns|videonews|on|170006|0|0|0|0"
            raise AssertionError("Unexpected SQL")
        with patch.object(m, "ledger", return_value=names), patch.object(
            m, "sql", side_effect=good
        ), patch.object(m.prior, "resources"):
            m.final_check(names, snapshot)
        for false_query in (m.INACTIVE_SQL, m.FINAL_SQL):
            with patch.object(m, "ledger", return_value=names), patch.object(
                m, "sql", side_effect=lambda sql: "f" if sql == false_query else good(sql)
            ), patch.object(m.prior, "resources"):
                with self.assertRaises(RuntimeError):
                    m.final_check(names, snapshot)

    def test_status_0059_0060_0061_no_automatic_retries(self):
        names = m.expected_versions()
        with patch.object(m.prior, "git_sha", return_value="a" * 40), patch.object(
            m, "expected_versions", return_value=names
        ), patch.object(m.prior, "container"):
            with patch.object(m, "ledger", return_value=names[:59]):
                m.main(["--status"])
            with patch.object(m, "ledger", return_value=names[:60]):
                m.main(["--status"])
        with patch.object(m, "ledger", return_value=names[:60]), patch.object(
            m, "sql", side_effect=AssertionError("Never auto-resume")
        ):
            with self.assertRaises(RuntimeError):
                m.preflight(names)

    def test_shell_errors_redacted_and_wrong_container_rejected(self):
        result = subprocess.CompletedProcess(
            args=["false"], returncode=1, stdout="private audit",
            stderr="database=password"
        )
        with patch.object(m.prior.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as failure:
                m.sql("SELECT 1")
            self.assertEqual(str(failure.exception), m.FAIL)


if __name__ == "__main__":
    unittest.main()
