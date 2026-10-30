"""Offline security tests for existing-owner personal DB enrollment.

Tests never connect to a database and never provision production credentials.
"""
import contextlib
import io
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import p2_owner_personal_db_enrollment as m


SAFE = "|".join((
    "vns", "videonews", "on", "170006", "59",
    "0059_canonical_event_title_fingerprint",
    "1", "1", "1", "0", "0", "1", "0", "0",
))


class OwnerEnrollmentTests(unittest.TestCase):
    def test_only_existing_single_active_owner_is_enrollable(self):
        m.check_baseline(SAFE)
        segments = SAFE.split("|")
        for index, alternate in [
            (2, "off"), (3, "160006"), (4, "58"), (5, "0058_previous"),
            (6, "2"), (7, "0"), (8, "0"), (9, "1"),
            (10, "1"), (11, "0"), (12, "1"), (13, "1"),
        ]:
            changed = segments.copy()
            changed[index] = alternate
            with self.assertRaises(RuntimeError, msg=f"unsafe field {index}"):
                m.check_baseline("|".join(changed))
        for bad in ("", SAFE + "|0", SAFE.replace("vns|", "postgres|", 1)):
            with self.assertRaises(RuntimeError):
                m.check_baseline(bad)

    def test_release_and_operator_approval_required_before_database(self):
        with patch.object(m, "git_state", return_value="a" * 40), patch.object(
            m, "db_container", side_effect=AssertionError("must never access DB")
        ):
            for env in (
                {},
                {m.ACK: m.ACK_VALUE},
                {m.SHA_APPROVAL: "a" * 40},
                {m.ACK: m.ACK_VALUE, m.SHA_APPROVAL: "b" * 40},
            ):
                with patch.dict(os.environ, env, clear=True):
                    with self.assertRaises(RuntimeError):
                        m.main(["--apply"])
        with patch.object(m.os, "geteuid", return_value=0):
            with self.assertRaises(RuntimeError):
                m.git_state()

    def test_preflight_read_only_and_never_auto_enrolls(self):
        calls = []
        with patch.object(m, "git_state", return_value="a" * 40), patch.object(
            m, "db_container", return_value=m.CONTAINER
        ), patch.object(
            m, "db_sql", side_effect=lambda sql, readonly: (
                calls.append((sql, readonly)), SAFE
            )[1],
        ), patch.object(m, "check_secret_parent") as secret, patch.object(
            m, "create_one_secret", side_effect=AssertionError("no credential creation")
        ):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                m.main(["--preflight"])
            self.assertEqual(calls, [(m.READ_SQL, True)])
            secret.assert_called_once_with(for_apply=False)
            self.assertIn("read-only", output.getvalue())
            self.assertNotIn("password", output.getvalue().lower())

    def test_must_have_exact_owner_private_secret_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "secrets"
            parent.mkdir(mode=0o700)
            working = parent / "p2-editorial-personal"
            with patch.object(m, "SECRET_DIR", working):
                parent.chmod(0o700)
                m.check_secret_parent(for_apply=False)
                parent.chmod(0o755)
                with self.assertRaises(RuntimeError):
                    m.check_secret_parent(for_apply=False)
                parent.chmod(0o700)
                working.mkdir(mode=0o700)
                with self.assertRaises(RuntimeError):
                    m.check_secret_parent(for_apply=False)
                working.rmdir()
                working.symlink_to(parent)
                with self.assertRaises(RuntimeError):
                    m.check_secret_parent(for_apply=False)

    def test_secret_is_exclusive_and_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp) / "secrets"
            parent.mkdir(mode=0o700)
            working = parent / "p2-editorial-personal"
            with patch.object(m, "SECRET_DIR", working):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    secret = m.create_one_secret()
                self.assertEqual(output.getvalue(), "")
                self.assertGreaterEqual(len(secret), 40)
                self.assertTrue(working.is_dir())
                path = working / m.SECRET_FILE
                self.assertEqual(path.read_text("ascii"), secret + "\n")
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(working.stat().st_mode), 0o700)
                with self.assertRaises(FileExistsError):
                    m.create_one_secret()

    def test_sql_grants_only_named_editorial_client_without_impersonation(self):
        secret = "temporary-test-password-not-a-real-credential" + "A" * 35
        verifier = m.scram_verifier(secret, b"x" * 16)
        sql = m.transaction(verifier)
        self.assertIn("CREATE ROLE editor_vns_owner_admin", sql)
        self.assertIn(
            "GRANT vns_p2_named_client TO editor_vns_owner_admin WITH INHERIT TRUE, SET FALSE;",
            sql,
        )
        self.assertIn("CONNECTION LIMIT 5", sql)
        self.assertIn("INSERT INTO vns.editor_db_principals", sql)
        self.assertIn("WHERE username='vns_owner_admin' AND role='admin' AND active=true", sql)
        self.assertIn("BEGIN;", sql)
        self.assertTrue(sql.endswith("COMMIT;\n"))
        self.assertNotIn(secret, sql)
        for forbidden in (
            "vns_source_admin_writer TO", "vns_host_approval_writer TO",
            "UPDATE vns.admin_source_registry", "INSERT INTO vns.admin_source_audit",
            "INSERT INTO vns.admin_source_host_audit",
        ):
            self.assertNotIn(forbidden, sql)
        with self.assertRaises(RuntimeError):
            m.transaction(secret)

    def test_apply_checks_origin_exactly_and_never_retries_db_write(self):
        sha = "a" * 40
        env = {m.ACK: m.ACK_VALUE, m.SHA_APPROVAL: sha}
        calls = []
        def command(argv, **_kwargs):
            self.assertIn("ls-remote", argv)
            return sha + " refs/heads/main"
        def query(sql, readonly):
            calls.append((sql, readonly))
            return SAFE if readonly else ""
        with patch.dict(os.environ, env, clear=True), patch.object(
            m, "run", side_effect=command
        ), patch.object(m, "db_container", return_value=m.CONTAINER), patch.object(
            m, "db_sql", side_effect=query
        ), patch.object(m, "check_secret_parent") as validate, patch.object(
            m, "create_one_secret", return_value="testcredential-" + "x" * 60
        ):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                m.apply(sha=sha)
            self.assertEqual(len(calls), 2)
            self.assertTrue(calls[0][1])
            self.assertFalse(calls[1][1])
            self.assertIn("one existing personal owner", output.getvalue())
            validate.assert_called_once_with(for_apply=True)
        for remote in ("", sha, "b" * 40 + " refs/heads/main", sha + " refs/heads/dev"):
            with patch.dict(os.environ, env, clear=True), patch.object(
                m, "run", return_value=remote
            ), patch.object(
                m, "db_container", side_effect=AssertionError("No database")
            ):
                with self.assertRaises(RuntimeError):
                    m.apply(sha=sha)

    def test_sql_and_subprocess_failures_are_redacted(self):
        failure = subprocess.CompletedProcess(
            args=[], returncode=2, stdout="personal-secret-here",
            stderr="postgres error credential SHA",
        )
        with patch.object(m.subprocess, "run", return_value=failure):
            with self.assertRaises(RuntimeError) as e:
                m.run(["docker", "exec", "dummy"])
            self.assertEqual(str(e.exception), m.FAIL)
        with self.assertRaises(RuntimeError):
            m.db_sql("SELECT current_user;", readonly=True)
        with patch.object(m, "run") as run:
            with self.assertRaises(RuntimeError):
                m.db_sql("SELECT current_user;", readonly=True)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
