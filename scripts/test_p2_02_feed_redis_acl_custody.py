"""Offline P2-02 feed-only Redis ACL custody: preserve original P1 accounts."""
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p2_02_feed_redis_acl_custody as acl


class FeedRedisACLTests(unittest.TestCase):
    def fixture(self):
        root = tempfile.TemporaryDirectory()
        path = Path(root.name)
        secrets = path / "secrets"
        secrets.mkdir(mode=0o700)
        secrets.chmod(0o700)
        producer_password = "P" * 64
        worker = "W" * 64
        provider = "V" * 64
        original = (
            "user default off\n"
            f"user vns_worker on #{hashlib.sha256(worker.encode()).hexdigest()} "
            "~bull:vns:* +@all -@admin -@dangerous +info\n"
            f"user vns_provider_producer on #{hashlib.sha256(provider.encode()).hexdigest()} "
            "resetkeys ~bull:vns:vns-provider-text:* resetchannels "
            "&bull:vns:vns-provider-text:* +@all -@dangerous +info +acl|whoami\n"
        ).encode("ascii")
        (secrets / "redis_acl").write_bytes(original)
        (secrets / "redis_acl").chmod(0o644)
        return root, path, secrets, original

    def test_exact_two_names_scope_and_command_restrictions(self):
        self.assertEqual([u for u, _ in acl.USERS], [
            "vns_feed_producer_prod", "vns_feed_consumer_prod"
        ])
        self.assertEqual(acl.SCOPE, "bull:vns:feed:vns-feed-poll:*")
        lines = [
            acl.acl_line(user, pw).decode("ascii")
            for (user, _), pw in zip(acl.USERS, ("a"*64, "b"*64))
        ]
        for line in lines:
            self.assertIn("resetkeys ~" + acl.SCOPE, line)
            self.assertIn("resetchannels &" + acl.SCOPE, line)
            self.assertIn(" -@admin -@dangerous ", line)
            self.assertNotIn(" ~*", line)
            self.assertNotIn(" ~bull:vns:* ", line)
            self.assertNotIn(" +@admin", line)
        self.assertNotEqual(lines[0], lines[1])
        with self.assertRaises(ValueError):
            acl.acl_line(acl.USERS[0][0], "short")

    def test_default_off_and_existing_users_required(self):
        with self.fixture()[0] as temp:
            pass
        with tempfile.TemporaryDirectory() as root:
            _, _, _, _ = self.fixture()
        password = "a"*64
        base = (
            "user default off\n"
            "user vns_worker on ~bull:vns:* +@all\n"
            "user vns_provider_producer on ~bull:vns:vns-provider-text:* +@all\n"
        ).encode("ascii")
        acl.acl_users(base)
        for bad in [
            base.replace(b"default off", b"default on"),
            base.replace(b"vns_worker on", b"vns_worker off"),
            base.replace(b"vns_provider_producer on", b"vns_provider_producer off"),
            base + acl.acl_line(acl.USERS[0][0], password),
            base + base,
            base.replace(b"vns_worker ", b"missing_worker "),
        ]:
            with self.assertRaises(ValueError):
                acl.acl_users(bad)

    def test_lifecycle_stage_prepare_verify_install_preserves_original(self):
        ctx, path, secrets, original = self.fixture()
        try:
            initial = acl.private_directory
            with (
                patch.object(acl, "ROOT", path),
                patch.object(acl, "SECRETS", secrets),
                patch.object(acl, "PRIVATE", secrets / "p2-feed-redis-acl"),
                patch.object(acl, "operator"),
                patch.object(
                    acl, "private_directory",
                    side_effect=lambda folder: initial(folder, expected_uid=os.geteuid()),
                ),
            ):
                acl.stage("a"*40)
                d = acl.PRIVATE
                self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)
                for _, name in acl.USERS:
                    self.assertEqual(stat.S_IMODE((d / name).stat().st_mode), 0o600)
                self.assertEqual((secrets / "redis_acl").read_bytes(), original)
                with self.assertRaises(FileExistsError):
                    acl.stage("a"*40)
                acl.preflight("a"*40)
                acl.prepare("a"*40)
                acl.verify("a"*40)
                acl.install_file("a"*40)
                acl.installed("a"*40)
                self.assertEqual((d / acl.BACKUP).read_bytes(), original)
                actual = (secrets / "redis_acl").read_bytes()
                self.assertEqual(actual, (d / acl.MERGED).read_bytes())
                self.assertEqual(stat.S_IMODE((secrets / "redis_acl").stat().st_mode), 0o644)
                for user, _ in acl.USERS:
                    self.assertEqual(actual.count(("user " + user + " ").encode()), 1)
                with self.assertRaises((FileExistsError, ValueError)):
                    acl.install_file("a"*40)
        finally:
            ctx.cleanup()

    def test_reject_acl_changes_between_prepare_and_verify(self):
        ctx, path, secrets, original = self.fixture()
        try:
            initial = acl.private_directory
            with (
                patch.object(acl, "SECRETS", secrets),
                patch.object(acl, "PRIVATE", secrets / "p2-feed-redis-acl"),
                patch.object(acl, "operator"),
                patch.object(acl, "private_directory",
                             side_effect=lambda folder: initial(folder, expected_uid=os.geteuid())),
            ):
                acl.stage("a"*40)
                acl.prepare("a"*40)
                (secrets / "redis_acl").write_bytes(
                    original + b"# changed original by another process\n"
                )
                with self.assertRaises(RuntimeError):
                    acl.verify("a"*40)
                with self.assertRaises(RuntimeError):
                    acl.install_file("a"*40)
                self.assertFalse((acl.PRIVATE / acl.BACKUP).exists())
        finally:
            ctx.cleanup()

    def test_reject_symlink_instead_of_acl(self):
        ctx, path, secrets, original = self.fixture()
        try:
            target = secrets / "original"
            (secrets / "redis_acl").rename(target)
            (secrets / "redis_acl").symlink_to(target)
            with patch.object(acl, "operator"), patch.object(
                acl, "SECRETS", secrets
            ), patch.object(
                acl, "private_directory",
                side_effect=lambda folder: os.open(folder, os.O_RDONLY | os.O_DIRECTORY),
            ):
                with self.assertRaises(OSError):
                    acl.stage("a"*40)
        finally:
            ctx.cleanup()

    def test_live_install_requires_explicit_pin_and_approval(self):
        with (
            patch.object(acl.os, "geteuid", return_value=1000),
            patch.object(acl, "command", side_effect=[
                "main", "a"*40, "", "videonews-studio|redis|healthy", "",
            ]) as command,
            patch.dict(os.environ, {}, clear=True),
        ):
            with self.assertRaises(PermissionError):
                acl.operator("a"*40, approval=True)
            self.assertEqual(command.call_count, 5)

    def test_no_implicit_install_or_untrusted_args(self):
        with patch.object(acl, "install_file") as install:
            with self.assertRaises(SystemExit):
                acl.main(["--expected-sha", "a"*40])
            install.assert_not_called()
        self.assertFalse(hasattr(acl, "restart_redis"))
        self.assertFalse(hasattr(acl, "redis_acl_load"))


if __name__ == "__main__":
    unittest.main()
