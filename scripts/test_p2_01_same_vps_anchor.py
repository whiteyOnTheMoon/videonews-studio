"""Offline default-deny checks for explicit single-VPS source anchor enrollment."""
from __future__ import annotations

import argparse
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import p2_01_same_vps_anchor as anchor
from provision_pg_runtime_logins import scram_verifier


def candidate() -> argparse.Namespace:
    return argparse.Namespace(
        expected_sha="a" * 40,
        source_revision=8,
        host_revision=7,
        envelope_sha256="b" * 64,
        policy_revision=1,
        policy_sha256="c" * 64,
        approval="",
        preflight=True,
        install=False,
        verify=False,
        handoff=False,
        verify_handoff=False,
    )


class SameVpsAnchorTests(unittest.TestCase):
    def test_candidate_validation_rejects_bad_hashes_and_revisions(self):
        args = candidate()
        anchor.validate_values(args)
        for field, value in (
            ("source_revision", 0),
            ("host_revision", -1),
            ("policy_revision", 0),
            ("source_revision", 10 ** 20),
            ("envelope_sha256", "f" * 63),
            ("policy_sha256", "F" * 64),
            ("policy_sha256", "';DROP ROLE vns;--"),
        ):
            changed = argparse.Namespace(**vars(args))
            setattr(changed, field, value)
            with self.assertRaises(ValueError, msg=field):
                anchor.validate_values(changed)

    def test_baseline_refuses_existing_anchor_and_wrong_source_audit(self):
        sql = anchor.baseline_sql(candidate())
        for token in (
            "schema_migrations)=61",
            "0061_single_owner_review_policy",
            "to_regnamespace('vns_source_anchor') IS NULL",
            "single_owner_review_policy",
            "admin_source_registry",
            "admin_source_host_approvals",
            "admin_source_audit",
            "admin_source_host_audit",
            "approved_for_publication",
            "source_revision",
        ):
            if token == "source_revision":
                continue
            self.assertIn(token, sql)
        self.assertNotIn("CREATE ROLE", sql)
        self.assertNotIn("INSERT INTO", sql)

    def test_atomic_authority_sql_scram_only_no_private_password(self):
        password = "S" * 64
        verifier = scram_verifier(password, b"x" * 16)
        sql = anchor.installation_sql(candidate(), verifier)
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertTrue(sql.rstrip().endswith("COMMIT;"))
        self.assertEqual(sql.count("\nCOMMIT;"), 1)
        self.assertEqual(sql.count("\nBEGIN;"), 0)
        self.assertEqual(sql.count("CREATE ROLE"), 2)
        self.assertEqual(sql.count("CREATE TABLE"), 3)  # all three authority tables
        self.assertNotIn(password, sql)
        self.assertIn("PASSWORD '" + verifier + "'", sql)
        self.assertIn("vns_source_anchor.high_water", sql)
        self.assertIn("vns_source_anchor.trust_policy_approvals", sql)
        self.assertIn("ALTER TABLE vns_source_anchor.high_water OWNER TO", sql)
        self.assertIn("CREATE ROLE vns_anchor_login_prod LOGIN NOINHERIT", sql)
        self.assertIn("GRANT EXECUTE ON FUNCTION vns_source_anchor.advance", sql)
        self.assertNotIn("GRANT SELECT ON", sql)
        self.assertNotIn("TRUNCATE vns.", sql)
        with self.assertRaises(ValueError):
            anchor.installation_sql(candidate(), "plaintext password")

    def test_readonly_verification_checks_every_authority_privilege(self):
        sql = anchor.verify_sql(candidate())
        for token in (
            "NOT has_schema_privilege('vns_anchor_login_prod','vns','USAGE')",
            "NOT has_table_privilege",
            "pg_auth_members",
            "pg_class",
            "pg_proc",
            "prosecdef",
            "policy_sha256='",
            "envelope_sha256='",
            "schema_migrations)=61",
        ):
            self.assertIn(token, sql)
        self.assertEqual(sql.count("NOT has_table_privilege"), 3)

    def test_initial_secret_is_exclusive_and_private(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            parent = base / "secrets"
            parent.mkdir(mode=0o700)
            dest = parent / "p2-anchor-login-custody"
            with (
                patch.object(anchor, "DIR", dest),
                patch.object(anchor, "os", wraps=anchor.os) as os_mock,
                patch.object(anchor, "secret_baseline", wraps=lambda: None),
            ):
                credential = anchor.create_secret()
                self.assertGreaterEqual(len(credential), 40)
                self.assertEqual((dest / anchor.FILE).read_text(), credential + "\n")
                self.assertEqual((dest.stat().st_mode & 0o777), 0o700)
                self.assertEqual(((dest / anchor.FILE).stat().st_mode & 0o777), 0o600)
                self.assertGreater(os_mock.fsync.call_count, 0)
                with self.assertRaises(FileExistsError):
                    anchor.create_secret()

    def test_preflight_does_not_install_or_read_secrets(self):
        args = candidate()
        argv = [
            "--preflight", "--expected-sha", args.expected_sha,
            "--source-revision", "8", "--host-revision", "7",
            "--envelope-sha256", args.envelope_sha256,
            "--policy-revision", "1", "--policy-sha256", args.policy_sha256,
        ]
        with (
            patch.object(anchor, "release"),
            patch.object(anchor, "ensure_no_feed_containers"),
            patch.object(anchor, "secret_baseline"),
            patch.object(anchor, "psql", return_value="t") as sql,
            patch.object(anchor, "create_secret") as create,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            anchor.main(argv)
            sql.assert_called_once()
            self.assertEqual(sql.call_args.kwargs, {})
            create.assert_not_called()
            self.assertIn("read-only", output.getvalue())

    def test_install_denies_missing_explicit_ack_even_when_preflight_passes(self):
        args = candidate()
        argv = [
            "--install", "--expected-sha", args.expected_sha,
            "--source-revision", "8", "--host-revision", "7",
            "--envelope-sha256", args.envelope_sha256,
            "--policy-revision", "1", "--policy-sha256", args.policy_sha256,
        ]
        with (
            patch.dict(anchor.os.environ, {anchor.ACK: "", anchor.ACK_SHA: ""}),
            patch.object(anchor, "release"),
            patch.object(anchor, "ensure_no_feed_containers"),
            patch.object(anchor, "secret_baseline"),
            patch.object(anchor, "psql", return_value="t"),
            patch.object(anchor, "create_secret") as create,
        ):
            with self.assertRaises(RuntimeError):
                anchor.main(argv)
            create.assert_not_called()

    def test_handoff_refuses_wrong_ack_before_accessing_secrets(self):
        args = candidate()
        args.approval = "false"
        with patch.object(anchor, "source_secret") as read:
            with self.assertRaises(RuntimeError):
                anchor.handoff(args)
            read.assert_not_called()

    def test_readonly_verification_does_not_create_any_role(self):
        args = candidate()
        argv = [
            "--verify", "--expected-sha", args.expected_sha,
            "--source-revision", "8", "--host-revision", "7",
            "--envelope-sha256", args.envelope_sha256,
            "--policy-revision", "1", "--policy-sha256", args.policy_sha256,
        ]
        with (
            patch.object(anchor, "release"),
            patch.object(anchor, "psql", return_value="t") as sql,
            patch.object(anchor, "create_secret") as create,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            anchor.main(argv)
            sql.assert_called_once()
            self.assertEqual(sql.call_args.kwargs, {})
            create.assert_not_called()
            self.assertIn("verified", output.getvalue())


if __name__ == "__main__":
    unittest.main()
