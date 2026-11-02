"""P2-01: reviewed 0059=>0061 schema upgrade remains opt-in and preserves audits."""
import os
import re
import unittest
from unittest.mock import patch

import p2_01_schema_0059_to_0061 as m

SHA = "a" * 40
SNAPSHOT = "8:" + "a" * 32 + "|7:" + "b" * 32 + "|2:" + "c" * 32
AUDIT = "8:" + "d" * 32 + "|7:" + "e" * 32


def names():
    return [f"{i:04d}_fixture" for i in range(1, 60)] + list(m.NEW)


def simulate_sql(*, audit=AUDIT, registered=True, policy_on=False):
    def query(text, *, readonly=True, timeout=40):
        if text == m.prior.SAFETY_SQL:
            return "vns|videonews|on|170006|0|0|0|0"
        if text == m.prior.UNCHANGED_SQL:
            return SNAPSHOT
        if text == m.REVIEWED_AUDIT_SNAPSHOT_SQL:
            return audit
        if text == m.REVIEWED_STATE_SQL:
            return "t" if registered else "f"
        if text == m.INACTIVE_SQL:
            return "f" if registered else "t"
        if text in (m.BASELINE_SQL, m.REQUIRED_ROLES_SQL):
            return "t"
        if text == m.FINAL_SQL:
            return "f" if policy_on else "t"
        raise AssertionError("unexpected SQL")
    return query


class PreserveExistingRegistry(unittest.TestCase):
    def test_reviewed_preflight_allows_nonempty_reviewed_registry_only_explicitly(self):
        with patch.object(m, "ledger", return_value=names()[:59]), patch.object(
            m, "sql", side_effect=simulate_sql()
        ), patch.object(m.prior, "resources"):
            self.assertEqual(m.preflight(names(), reviewed_state=True), SNAPSHOT)
            with self.assertRaises(RuntimeError):
                m.preflight(names())  # Existing default path still requires empty.
        with patch.object(m, "ledger", return_value=names()[:59]), patch.object(
            m, "sql", side_effect=simulate_sql(registered=False)
        ), patch.object(m.prior, "resources"):
            with self.assertRaises(RuntimeError):
                m.preflight(names(), reviewed_state=True)

    def test_requires_explicit_reviewed_ack_and_exact_release_before_db(self):
        cases = [
            {},
            {m.ACK: "INSTALL_SCHEMA_ONLY_0060_0061", m.SHA_ACK: SHA},
            {m.ACK: "INSTALL_SCHEMA_ONLY_0060_0061",
             m.SHA_ACK: SHA,
             m.REVIEWED_ACK: "PRESERVE_EXISTING"},
            {m.ACK: "INSTALL_SCHEMA_ONLY_0060_0061",
             m.SHA_ACK: "b" * 40,
             m.REVIEWED_ACK: m.REVIEWED_ACK_VALUE},
        ]
        for values in cases:
            with self.subTest(values=values), patch.dict(os.environ, values, clear=True), patch.object(
                m.prior, "git_sha", return_value=SHA
            ), patch.object(m, "expected_versions", return_value=names()), patch.object(
                m.prior, "container", side_effect=AssertionError("must never reach database")
            ):
                with self.assertRaisesRegex(RuntimeError, "REFUSED"):
                    m.main(["--apply-reviewed"])

    def test_readonly_reviewed_preflight_never_runs_upgrade_transactions(self):
        calls = []
        def query(sql, *, readonly=True, timeout=40):
            self.assertTrue(readonly)
            calls.append(sql)
            return simulate_sql()(sql)
        with patch.object(m.prior, "git_sha", return_value=SHA), patch.object(
            m, "expected_versions", return_value=names()
        ), patch.object(m.prior, "container"), patch.object(
            m, "ledger", return_value=names()[:59]
        ), patch.object(m.prior, "resources"), patch.object(
            m, "sql", side_effect=query
        ):
            m.main(["--preflight-reviewed"])
        self.assertEqual(calls.count(m.REVIEWED_AUDIT_SNAPSHOT_SQL), 1)
        self.assertIn(m.REVIEWED_STATE_SQL, calls)
        self.assertNotIn(m.INACTIVE_SQL, calls)

    def test_audit_hash_checks_historical_host_rows_excluding_new_0061_column(self):
        self.assertIn("to_jsonb(a)-'approval_model'", m.REVIEWED_AUDIT_SNAPSHOT_SQL)
        self.assertIn("FROM vns.admin_source_audit", m.REVIEWED_AUDIT_SNAPSHOT_SQL)
        self.assertIn("FROM vns.admin_source_host_audit", m.REVIEWED_AUDIT_SNAPSHOT_SQL)
        self.assertTrue(re.fullmatch(
            r"[0-9]{1,16}:[0-9a-f]{32}\|[0-9]{1,16}:[0-9a-f]{32}", AUDIT
        ))
        # Untrusted/malformed snapshot must fail before SQL migration.
        for value in ("", "1:abc|2:def", AUDIT + "|extra", AUDIT.replace("|", "/")):
            with patch.object(m.prior, "git_sha", return_value=SHA), patch.object(
                m, "expected_versions", return_value=names()
            ), patch.object(m.prior, "container"), patch.object(
                m, "ledger", return_value=names()[:59]
            ), patch.object(m.prior, "resources"), patch.object(
                m, "sql", side_effect=simulate_sql(audit=value)
            ):
                with self.assertRaises(RuntimeError):
                    m.main(["--preflight-reviewed"])

    def test_reviewed_upgrade_checks_snapshot_before_each_irreversible_step(self):
        installed = names()[:59].copy()
        changed = False
        touched = []
        def query(statement, *, readonly=True, timeout=40):
            nonlocal changed
            if not readonly:
                self.assertEqual(timeout, 140)
                self.assertTrue(statement.startswith("--"))
                installed.append(names()[len(installed)])
                touched.append(installed[-1])
                changed = True
                return ""
            if changed and statement == m.REVIEWED_AUDIT_SNAPSHOT_SQL:
                return "8:" + "f"*32 + "|7:" + "e"*32
            return simulate_sql()(statement)
        with patch.object(m, "ledger", side_effect=lambda: installed.copy()), patch.object(
            m, "sql", side_effect=query
        ), patch.object(m, "MIGRATIONS") as paths:
            fake = paths.__truediv__.return_value
            fake.read_text.return_value = "-- fixed audited SQL\nBEGIN;\nCOMMIT;"
            with self.assertRaises(RuntimeError):
                m.apply(names(), SNAPSHOT, reviewed_state=True, audit_snapshot=AUDIT)
        self.assertEqual(touched, [names()[59]])
        self.assertEqual(installed, names()[:60])  # Manual review, no auto resume.

    def test_reviewed_final_requires_source_and_both_audits_unchanged(self):
        with patch.object(m, "ledger", return_value=names()), patch.object(
            m, "sql", side_effect=simulate_sql()
        ), patch.object(m.prior, "resources"):
            m.final_check(names(), SNAPSHOT, reviewed_state=True, audit_snapshot=AUDIT)
            with self.assertRaises(RuntimeError):
                m.final_check(names(), SNAPSHOT, reviewed_state=True,
                              audit_snapshot="8:" + "a"*32 + "|7:" + "b"*32)
        with patch.object(m, "ledger", return_value=names()), patch.object(
            m, "sql", side_effect=simulate_sql(policy_on=True)
        ), patch.object(m.prior, "resources"):
            with self.assertRaises(RuntimeError):
                m.final_check(names(), SNAPSHOT, reviewed_state=True, audit_snapshot=AUDIT)


if __name__ == "__main__":
    unittest.main()
