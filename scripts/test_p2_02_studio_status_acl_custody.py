"""Disposable, offline tests for the one-user Studio status ACL operator."""
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p2_02_studio_status_acl_custody as acl


class StudioStatusACLTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.secrets = Path(self.temp.name) / "secrets"
        self.secrets.mkdir(mode=0o700)
        self.secrets.chmod(0o700)
        self.original = (
            "user default off\n"
            "user vns_worker on ~bull:vns:* +@all -@admin -@dangerous\n"
            "user vns_provider_producer on ~bull:vns:vns-provider-text:* +@all\n"
            "user vns_feed_producer_prod on "
            "~bull:vns:feed:vns-feed-poll:* +@all -@admin -@dangerous\n"
            "user vns_feed_consumer_prod on "
            "~bull:vns:feed:vns-feed-poll:* +@all -@admin -@dangerous\n"
        ).encode("ascii")
        self.aclfile = self.secrets / "redis_acl"
        self.aclfile.write_bytes(self.original)
        self.aclfile.chmod(0o644)
        self.patchers = [
            patch.object(acl, "SECRETS", self.secrets),
            patch.object(acl, "PRIVATE", self.secrets / "p2-studio-status-redis-acl"),
            patch.object(acl, "OPERATOR_UID", os.getuid()),
            patch.object(acl, "operator"),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.sha = "a" * 40

    def prepare(self):
        with patch.dict(os.environ, {
            "VNS_P2_STUDIO_STATUS_ACL_PREPARE_APPROVED": acl.PREPARE_ACK,
        }):
            acl.prepare(self.sha)

    def install(self):
        with patch.dict(os.environ, {
            "VNS_P2_STUDIO_STATUS_ACL_INSTALL_APPROVED": acl.INSTALL_ACK,
            "VNS_P2_STUDIO_STATUS_ACL_RECOVERY_VERIFIED": acl.RESTORE_ACK,
        }):
            acl.install_file(self.sha)

    def test_exact_read_commands_and_keys_and_no_other_redis_roles(self):
        password = b"a" * 64 + b"\n"
        line = acl.acl_line(password).decode("ascii")
        self.assertTrue(line.startswith("user vns_feed_status_studio on #"))
        self.assertIn(hashlib.sha256(password[:-1]).hexdigest(), line)
        for allowed in ("+zscore", "+hget", "+exists", "+ping", "+quit"):
            self.assertIn(allowed, line)
        for key in (
            "~bull:vns:feed:vns-feed-poll:completed",
            "~bull:vns:feed:vns-feed-poll:failed",
            "~bull:vns:feed:vns-feed-poll:vns-feed-tick-*",
        ):
            self.assertIn(key, line)
        self.assertIn("resetchannels -@all", line)
        for forbidden in ("+@all", "+eval", "+set", "+zadd", "+hset",
                          "~*", "~bull:vns:*", "+scan", "+keys"):
            self.assertNotIn(forbidden, line)
        self.assertNotIn("PASS", line)
        for bad in (b"short\n", b"bad password\n", b"a" * 64):
            with self.assertRaises(ValueError):
                acl.acl_line(bad)

    def test_preflight_is_readonly_and_exact_five_user_baseline(self):
        before = self.aclfile.read_bytes()
        acl.preflight(self.sha)
        self.assertEqual(self.aclfile.read_bytes(), before)
        self.assertFalse(acl.PRIVATE.exists())
        for original in (
            before + b"user attacker on +@all\n",
            before.replace(b"vns_feed_consumer_prod", b"missing_feed_consumer"),
            before.replace(b"vns_feed_producer_prod on", b"vns_feed_producer_prod off"),
            before.replace(b"~bull:vns:feed:vns-feed-poll:*",
                           b"~bull:vns:vns-jobs:*"),
            before.replace(b"default off", b"default on"),
        ):
            self.aclfile.write_bytes(original)
            with self.assertRaises(ValueError):
                acl.preflight(self.sha)
        self.aclfile.write_bytes(before)

    def test_private_prepare_verify_and_host_file_install_is_single_use(self):
        acl.preflight(self.sha)
        self.prepare()
        self.assertEqual(self.aclfile.read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(acl.PRIVATE.stat().st_mode), 0o700)
        for name in (acl.PASSWORD, acl.CANDIDATE, acl.DIGEST):
            self.assertEqual(stat.S_IMODE((acl.PRIVATE / name).stat().st_mode), 0o600)
        acl.verify(self.sha)
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.install()
        acl.installed(self.sha)
        self.assertEqual((acl.PRIVATE / acl.BACKUP).read_bytes(), self.original)
        new = self.aclfile.read_bytes()
        self.assertTrue(new.startswith(self.original))
        self.assertEqual(new.count(b"user vns_feed_status_studio on #"), 1)
        self.assertEqual(stat.S_IMODE(self.aclfile.stat().st_mode), 0o644)
        with self.assertRaises((ValueError, FileExistsError, RuntimeError)):
            self.install()
        with self.assertRaises(ValueError):
            acl.preflight(self.sha)

    def test_mutation_requires_separate_exact_operator_approvals(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(PermissionError):
                acl.prepare(self.sha)
            self.assertFalse(acl.PRIVATE.exists())
            with self.assertRaises(PermissionError):
                acl.install_file(self.sha)
        self.prepare()
        with patch.dict(os.environ, {
            "VNS_P2_STUDIO_STATUS_ACL_INSTALL_APPROVED": acl.INSTALL_ACK,
            "VNS_P2_STUDIO_STATUS_ACL_RECOVERY_VERIFIED": "",
        }, clear=True):
            with self.assertRaises(PermissionError):
                acl.install_file(self.sha)
        self.assertEqual(self.aclfile.read_bytes(), self.original)

    def test_tampered_baseline_or_secret_fails_before_host_file_change(self):
        self.prepare()
        self.aclfile.write_bytes(self.original + b"# concurrent host modification\n")
        with self.assertRaises(RuntimeError):
            acl.verify(self.sha)
        with self.assertRaises(RuntimeError):
            self.install()
        self.assertFalse((acl.PRIVATE / acl.BACKUP).exists())
        self.aclfile.write_bytes(self.original)
        (acl.PRIVATE / acl.PASSWORD).chmod(0o644)
        with self.assertRaises(PermissionError):
            acl.verify(self.sha)

    def test_acl_file_symlink_is_refused(self):
        target = self.secrets / "original"
        self.aclfile.rename(target)
        self.aclfile.symlink_to(target)
        with self.assertRaises(OSError):
            acl.preflight(self.sha)

    def test_missing_mode_or_invalid_arguments_cannot_mutate(self):
        with self.assertRaises(SystemExit):
            acl.main(["--expected-sha", self.sha])
        with self.assertRaises(SystemExit):
            acl.main(["--preflight", "--install-file", "--expected-sha", self.sha])
        self.assertFalse(acl.PRIVATE.exists())
        self.assertEqual(self.aclfile.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
