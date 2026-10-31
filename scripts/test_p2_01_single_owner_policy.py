"""P2-01 single-owner default-off DBA policy guard regression tests."""
import unittest
from unittest.mock import patch

import p2_01_single_owner_policy as p


class OnePersonOwnerPolicy(unittest.TestCase):
    def test_preflight_reads_only_and_rejects_missing_policy(self):
        with patch.object(p, "query", return_value="t") as q:
            p.require_clean_owner()
            q.assert_called_once_with(p.PRECHECK_SQL)
        for value in ("f", "", "INVALID"):
            with patch.object(p, "query", return_value=value):
                with self.assertRaises(RuntimeError):
                    p.require_clean_owner()

    def test_owner_is_exact_preexisting_named_login_and_no_sources(self):
        sql = p.PRECHECK_SQL
        self.assertIn("username='vns_owner_admin'", sql)
        self.assertIn("login_role='editor_vns_owner_admin'", sql)
        self.assertIn("a.role='admin' AND a.active", sql)
        self.assertIn("p.auth_version=a.auth_version", sql)
        self.assertIn("pg_has_role(", sql)
        self.assertIn("count(*)=61", sql)
        self.assertIn("enabled=false AND owner_editor_id IS NULL", sql)
        self.assertIn("sources='[]'::jsonb", sql)
        self.assertIn("approved_hosts='[]'::jsonb", sql)
        self.assertIn("admin_source_audit", sql)
        self.assertIn("admin_source_host_audit", sql)
        self.assertIn("NOT has_table_privilege(", sql)

    def test_transaction_checks_before_mutation_and_commits_once(self):
        sql = p.transaction()
        self.assertEqual(sql.count("BEGIN;"), 1)
        self.assertEqual(sql.count("COMMIT;"), 1)
        self.assertIn("LOCK TABLE vns.admin_source_registry", sql)
        self.assertIn("IF NOT (SELECT", sql)
        self.assertLess(sql.index("IF NOT (SELECT"), sql.index("UPDATE vns.single_owner_review_policy"))
        self.assertIn("owner_editor_id=(", sql)
        self.assertIn("operator_reason=", sql)
        self.assertIn("authorized_at=clock_timestamp()", sql)
        self.assertIn(p.REASON, sql)
        self.assertIn(p.POSTCHECK_SQL, sql)
        self.assertNotIn("INSERT INTO vns.editor_accounts", sql)
        self.assertNotIn("admin_commit_source_registry(", sql)
        self.assertNotIn("named_host_change(", sql)
        self.assertNotIn("pg_notify(", sql)
        self.assertNotIn("TRUNCATE", sql)

    def test_wrong_ack_or_sha_denied_before_any_database_write(self):
        sha = "a" * 40
        cases = [
            {},
            {p.ACK: p.ACK_VALUE},
            {p.SHA_ACK: sha},
            {p.ACK: p.ACK_VALUE, p.SHA_ACK: "b" * 40},
            {p.ACK: "ENABLE_ANY_OWNER", p.SHA_ACK: sha},
        ]
        for env in cases:
            with self.subTest(env=env), patch.dict("os.environ", env, clear=True), patch.object(
                p, "require_clean_owner", side_effect=AssertionError("Not reached")
            ):
                with self.assertRaises(RuntimeError):
                    p.apply(sha)

    def test_remote_exact_sha_denial_prior_to_sql(self):
        sha = "a" * 40
        class Result:
            returncode = 0
            stdout = "b" * 40 + "\trefs/heads/main\n"
        with patch.dict("os.environ", {p.ACK: p.ACK_VALUE, p.SHA_ACK: sha}), patch.object(
            p.subprocess, "run", return_value=Result()
        ), patch.object(p, "query", side_effect=AssertionError("No SQL")):
            with self.assertRaises(RuntimeError):
                p.apply(sha)

    def test_only_one_exact_sql_transaction_and_postcheck(self):
        sha = "a" * 40
        class Result:
            returncode = 0
            stdout = sha + "\trefs/heads/main\n"
        calls = []
        def query(sql, *, readonly=True):
            calls.append((sql, readonly))
            if sql == p.PRECHECK_SQL or sql == p.POSTCHECK_SQL:
                return "t"
            if sql == p.STATUS_SQL:
                return "SOLE_OWNER_ENABLED"
            if sql == p.transaction():
                return "t"
            raise AssertionError("Unexpected SQL")
        with patch.dict("os.environ", {p.ACK: p.ACK_VALUE, p.SHA_ACK: sha}), patch.object(
            p.subprocess, "run", return_value=Result()
        ), patch.object(p, "query", side_effect=query):
            p.apply(sha)
        assert sum(not ro for _, ro in calls) == 1
        assert calls[0] == (p.PRECHECK_SQL, True)
        assert calls[1] == (p.transaction(), False)

    def test_postcheck_failure_does_not_claim_success(self):
        sha = "a" * 40
        class Result:
            returncode = 0
            stdout = sha + "\trefs/heads/main\n"
        def q(sql, *, readonly=True):
            if sql == p.PRECHECK_SQL:
                return "t"
            return "f"
        with patch.dict("os.environ", {p.ACK: p.ACK_VALUE, p.SHA_ACK: sha}), patch.object(
            p.subprocess, "run", return_value=Result()
        ), patch.object(p, "query", side_effect=q):
            with self.assertRaises(RuntimeError):
                p.apply(sha)

    def test_status_has_no_mutation_and_is_account_bound(self):
        sql = p.STATUS_SQL
        self.assertIn("SOLE_OWNER_ENABLED", sql)
        self.assertIn("editor_vns_owner_admin", sql)
        self.assertIn("enabled=false", sql)
        self.assertIn("INVALID", sql)
        with patch.object(p, "require_identity", return_value="a" * 40), patch.object(
            p, "query", return_value="OFF"
        ) as q:
            p.main(["--status"])
            q.assert_called_once_with(p.STATUS_SQL)
        with patch.object(p, "require_identity", return_value="a" * 40), patch.object(
            p, "query", return_value="INVALID"
        ):
            with self.assertRaises(RuntimeError):
                p.main(["--status"])


if __name__ == "__main__":
    unittest.main()
