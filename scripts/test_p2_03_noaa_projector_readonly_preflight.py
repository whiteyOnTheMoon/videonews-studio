#!/usr/bin/env python3
"""Offline, fail-closed contract tests; never contact VPS/Docker/SQL."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
import stat
from types import SimpleNamespace
from unittest.mock import patch

FILE = Path(__file__).with_name("p2_03_noaa_projector_readonly_preflight.py")
spec = importlib.util.spec_from_file_location("noaa_projector_preflight", FILE)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class PreflightContractTests(unittest.TestCase):
    def valid(self):
        return {
            **module.EXPECTED_COUNTS,
            "read_only": True, "schema_ready": True,
            "source_ready": True, "host_grant_ready": True,
            "projector_login": "vns_feed_project_login_prod",
        }

    def test_valid_snapshot(self):
        self.assertEqual(module.validate_snapshot(self.valid())["missing"], 8)

    def test_every_count_is_fail_closed(self):
        for key, value in module.EXPECTED_COUNTS.items():
            for replacement in (value + 1, str(value), True, None):
                with self.subTest(key=key, replacement=replacement):
                    row = self.valid()
                    row[key] = replacement
                    with self.assertRaises(RuntimeError):
                        module.validate_snapshot(row)

    def test_every_boolean_guard_is_mandatory(self):
        for key in ("read_only", "schema_ready", "source_ready",
                    "host_grant_ready"):
            for bad in (False, None, 1):
                row = self.valid()
                row[key] = bad
                with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeError):
                    module.validate_snapshot(row)

    def test_invalid_login_is_denied(self):
        for value in ("postgres", "vns_feed_project_login_", "", None,
                      "vns_feed_project_login_ci",
                      "vns_feed_project_login_prod; DROP TABLE x"):
            row = self.valid()
            row["projector_login"] = value
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                module.validate_snapshot(row)

    def test_release_root_and_sha_must_be_explicit(self):
        with patch.object(module.os, "geteuid", return_value=1000):
            with self.assertRaises(RuntimeError):
                module.verify_release("e17bff79331840f28ceecb5afb8f2919e11d0a05")
        with patch.object(module.os, "geteuid", return_value=0):
            with self.assertRaises(RuntimeError):
                module.verify_release("main")

    def test_git_directory_accepts_standard_safe_mode_not_world_write(self):
        sha = "e17bff79331840f28ceecb5afb8f2919e11d0a05"
        def read(args, stdin=None):
            if args[-2:] == ["branch", "--show-current"]:
                return "main"
            if args[-2:] == ["rev-parse", "HEAD"]:
                return sha
            if args[-2:] == ["status", "--porcelain"]:
                return ""
            if args[-3:-1] == ["rev-parse", "--verify"]:
                return module.EXPECTED_WORKER_SHA
            if "diff" in args and "--quiet" in args:
                return ""
            raise AssertionError("unexpected command")
        index = SimpleNamespace(st_mode=stat.S_IFREG | 0o600,
                                st_uid=1000, st_gid=1000, st_nlink=1,
                                st_dev=1, st_ino=2, st_mtime_ns=3, st_ctime_ns=4)
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755,
                                    st_uid=1000, st_gid=1000)
        def lstat(path):
            return index if path.name == "index" else directory
        with patch.object(module.os, "geteuid", return_value=0), \
             patch.object(module, "command", side_effect=read), \
             patch.object(module.Path, "lstat", autospec=True, side_effect=lstat):
            for mode in (0o700, 0o750, 0o755, 0o770, 0o775):
                directory.st_mode = stat.S_IFDIR | mode
                module.verify_release(sha)
            for mode in (0o777, 0o757):
                directory.st_mode = stat.S_IFDIR | mode
                with self.assertRaises(RuntimeError):
                    module.verify_release(sha)
            directory.st_mode = stat.S_IFLNK | 0o777
            with self.assertRaises(RuntimeError):
                module.verify_release(sha)

    def test_git_index_identity_requires_ap_owned_unlinked_stable_file(self):
        meta = SimpleNamespace(st_mode=stat.S_IFREG | 0o600,
                               st_uid=1000, st_gid=1000, st_nlink=1,
                               st_dev=1, st_ino=22, st_mtime_ns=100,
                               st_ctime_ns=101)
        with patch.object(module.Path, "lstat", return_value=meta):
            self.assertEqual(module.git_index_identity(),
                             (1, 22, 100, 101, 1000, 1000))
            for key, value in (("st_uid", 0), ("st_nlink", 2),
                               ("st_mode", stat.S_IFREG | 0o644)):
                previous = getattr(meta, key)
                setattr(meta, key, value)
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    module.git_index_identity()
                setattr(meta, key, previous)

    def test_command_fails_closed_on_nonzero_even_empty_stdout(self):
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(
            returncode=1, stdout=""
        )) as run:
            with self.assertRaises(RuntimeError):
                module.command(["git", "status"])
            self.assertEqual(run.call_args.kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")

    def test_command_fails_closed_on_oversized_output(self):
        with patch.object(module.subprocess, "run", return_value=SimpleNamespace(
            returncode=0, stdout="x" * 16385
        )):
            with self.assertRaises(RuntimeError):
                module.command(["docker", "ps"])

    def test_running_image_or_unhealthy_database_refused(self):
        def read(argv, stdin=None):
            joined = " ".join(argv)
            if argv[:3] == ["docker", "image", "inspect"]:
                return module.EXPECTED_IMAGE_ID + "|" + module.EXPECTED_WORKER_SHA
            if argv[:3] == ["docker", "network", "inspect"]:
                return "true"
            if argv[:3] == ["docker", "inspect", "-f"]:
                return "videonews-studio|postgres|healthy"
            if argv[:3] == ["docker", "ps", "--filter"]:
                return ""
            if argv[:3] == ["docker", "ps", "-a"]:
                return ""
            if argv[:3] == ["docker", "ps", "--format"]:
                return ""
            raise AssertionError(joined)

        with patch.object(module, "command", side_effect=read) as command, \
                patch.object(module, "require_inode"):
            module.verify_image_and_runtime()
            self.assertTrue(any(
                "ancestor=" + module.EXPECTED_IMAGE_ID in " ".join(call.args[0])
                for call in command.call_args_list
            ))

        def bad_image(argv, stdin=None):
            if argv[:3] == ["docker", "image", "inspect"]:
                return "sha256:not-the-reviewed-image|" + module.EXPECTED_WORKER_SHA
            return read(argv, stdin)
        with patch.object(module, "command", side_effect=bad_image), \
                patch.object(module, "require_inode"):
            with self.assertRaises(RuntimeError):
                module.verify_image_and_runtime()

        def bad_db(argv, stdin=None):
            if argv[:3] == ["docker", "inspect", "-f"]:
                return "unknown|postgres|healthy"
            return read(argv, stdin)
        with patch.object(module, "command", side_effect=bad_db), \
                patch.object(module, "require_inode"):
            with self.assertRaises(RuntimeError):
                module.verify_image_and_runtime()

        def competing_worker(argv, stdin=None):
            if argv[:3] == ["docker", "ps", "--filter"]:
                return "parallel-worker"
            return read(argv, stdin)
        with patch.object(module, "command", side_effect=competing_worker), \
                patch.object(module, "require_inode"):
            with self.assertRaises(RuntimeError):
                module.verify_image_and_runtime()

    def test_invalid_signature_anchor_status_refused(self):
        valid = {
            "status": "parity_reviewable", "feed_started": False,
            "sql_source_revision_10": True, "sql_host_revision_10": True,
            "sql_approved_host_subset_equal_signed": True,
            "sql_anchor_digest_matches": True,
            "sql_trust_policy_matches": True,
        }
        import json
        with patch.object(module, "command", return_value=json.dumps(valid)):
            module.verify_signed_authority("e17bff79331840f28ceecb5afb8f2919e11d0a05")
        for key in valid:
            invalid = dict(valid)
            invalid[key] = None
            with self.subTest(key=key), patch.object(
                module, "command", return_value=json.dumps(invalid)
            ), self.assertRaises(RuntimeError):
                module.verify_signed_authority("e17bff79331840f28ceecb5afb8f2919e11d0a05")

    def test_sql_remains_bounded_read_only(self):
        sql = module.SQL
        self.assertTrue(sql.lstrip().startswith("WITH registry AS"))
        self.assertIn("vns.feed_poll_candidates", sql)
        self.assertNotIn("FOR SHARE", sql)
        self.assertNotIn("pg_advisory_xact_lock", sql)
        self.assertNotIn("INSERT INTO ", sql)
        self.assertNotIn("DELETE FROM ", sql)
        self.assertNotIn("UPDATE vns.", sql)

    def test_readonly_guards_and_no_operator_run_mode(self):
        text = FILE.read_text(encoding="utf-8")
        for required in (
            '"--no-optional-locks"', 'GIT_OPTIONAL_LOCKS="0"',
            'default_transaction_read_only=on', 'statement_timeout=10000',
            'lock_timeout=3000', 'vns_feed_project_client',
            'vns.project_approved_feed_candidates(text,integer)',
            'vns.project_feed_candidates(text,integer)', 'forbidden_access',
            '10', 'SIGNED',
        ):
            if required == 'SIGNED':
                required = "p2_02_nasa_signed_sql_readonly_witness.py"
            self.assertIn(required, text)
        for forbidden in (
            '"create"', '"start"', '"run"', '"network", "connect"',
            '"compose", "up"', '"docker", "build"', '"docker", "pull"',
            'os.chown(', 'os.chmod(', 'open(SECRET',
        ):
            self.assertNotIn(forbidden, text)
        self.assertIn('parser.add_argument("--preflight"', text)
        self.assertNotIn('parser.add_argument("--run"', text)


if __name__ == "__main__":
    unittest.main()
