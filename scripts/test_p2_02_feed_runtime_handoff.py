"""Disposable root integration of P2-02 feed credential handoff.

The workflow runs this only in ephemeral CI as root; five passwords are
synthetic and the real VPS and GitHub secrets are never accessed.
"""
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p2_02_feed_runtime_handoff as h


class FeedSecretHandoffTests(unittest.TestCase):
    def setUp(self):
        if (
            os.geteuid() != 0
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("CI") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != "whiteyOnTheMoon/videonews-studio"
            or not os.environ.get("GITHUB_RUN_ID", "").isdigit()
        ):
            self.skipTest("Rooted synthetic GitHub Actions only")
        self.sandbox = tempfile.TemporaryDirectory(prefix="vns-p202-handoff-", dir="/tmp")
        base = Path(self.sandbox.name)
        self.root = base / "repo"
        self.root.mkdir(mode=0o700)
        (self.root / "secrets").mkdir(mode=0o700)
        self.lib = base / "fake-var-lib"
        self.lib.mkdir(mode=0o700)
        self.dest_parent = self.lib / "videonews-studio"
        self.dest = self.dest_parent / "p2-feed-runtime-secrets"
        self.passwords = []
        for i, (relative, _, _) in enumerate(h.SOURCES):
            path = self.root / relative
            if not path.parent.exists():
                path.parent.mkdir(mode=0o700)
                os.chown(path.parent, 1000, 1000)
                path.parent.chmod(0o700)
            content = (chr(ord("a") + i) * 62 + "\n").encode("ascii")
            self.passwords.append(content)
            path.write_bytes(content)
            os.chown(path, 1000, 1000)
            path.chmod(0o600)
        self.patches = [
            patch.object(h, "ROOT", self.root),
            patch.object(h, "DEST_PARENT", self.dest_parent),
            patch.object(h, "DEST_DIR", self.dest),
            patch.object(h, "secure_parent", side_effect=lambda: os.open(
                self.lib, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            )),
            patch.object(h, "check_release"),
            patch.object(h, "check_container_absence"),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        if not hasattr(self, "patches"):
            return
        for item in reversed(self.patches):
            item.stop()
        self.sandbox.cleanup()

    def test_one_shot_install_exact_owner_mode_and_bytes(self):
        self.assertEqual(h.original_passwords(), tuple(self.passwords))
        h.install("a" * 40, h.INSTALL_APPROVAL)
        h.verify_destinations()
        self.assertEqual(stat.S_IMODE(self.dest.stat().st_mode), 0o700)
        self.assertEqual(self.dest.stat().st_uid, 0)
        self.assertEqual(set(p.name for p in self.dest.iterdir()), {
            name for _, name, _ in h.SOURCES
        })
        for (relative, name, uid), original in zip(h.SOURCES, self.passwords):
            installed = self.dest / name
            st = installed.lstat()
            self.assertEqual((st.st_uid, st.st_gid), (uid, uid))
            self.assertEqual(stat.S_IMODE(st.st_mode), 0o400)
            self.assertEqual(st.st_nlink, 1)
            self.assertEqual(installed.read_bytes(), original)
            self.assertEqual((self.root / relative).read_bytes(), original)
        with self.assertRaises(FileExistsError):
            h.install("a" * 40, h.INSTALL_APPROVAL)
        h.verify_destinations()

    def test_missing_approval_fails_without_any_creation(self):
        with self.assertRaises(PermissionError):
            h.install("a" * 40, "")
        self.assertFalse(self.dest_parent.exists())

    def test_source_symlink_fails_before_creation(self):
        path = self.root / h.SOURCES[0][0]
        backup = path.with_name("real")
        path.rename(backup)
        path.symlink_to(backup)
        with self.assertRaises(OSError):
            h.install("a" * 40, h.INSTALL_APPROVAL)
        self.assertFalse(self.dest_parent.exists())

    def test_source_password_change_fails_read_only_verification(self):
        h.install("a" * 40, h.INSTALL_APPROVAL)
        original = self.root / h.SOURCES[3][0]
        original.write_bytes(b"z" * 60 + b"\n")
        with self.assertRaises(RuntimeError):
            h.verify_destinations()

    def test_unexpected_destination_filename_rejected(self):
        h.install("a" * 40, h.INSTALL_APPROVAL)
        (self.dest / "unexpected").write_bytes(b"artifact")
        with self.assertRaises(RuntimeError):
            h.verify_destinations()

    def test_destination_mode_and_ownership_rejected(self):
        h.install("a" * 40, h.INSTALL_APPROVAL)
        target = self.dest / h.SOURCES[1][1]
        target.chmod(0o440)
        with self.assertRaises(PermissionError):
            h.verify_destinations()

    def test_source_duplicate_password_denied(self):
        source = self.root / h.SOURCES[1][0]
        source.write_bytes(self.passwords[0])
        with self.assertRaises(ValueError):
            h.original_passwords()

    def test_no_container_commands_or_password_rotation(self):
        self.assertFalse(hasattr(h, "restart_redis"))
        self.assertFalse(hasattr(h, "start_feed_producer"))
        self.assertFalse(hasattr(h, "rotate_password"))
        self.assertNotIn("docker", h.create_secret.__code__.co_names)


if __name__ == "__main__":
    unittest.main()
