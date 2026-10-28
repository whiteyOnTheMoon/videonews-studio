#!/usr/bin/env python3
"""Offline synthetic key distribution tests; never reads real operator secrets."""
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p1_09_prompt_key_distribution as custody


class PromptKeyDistributionTests(unittest.TestCase):
    def environment(self):
        return tempfile.TemporaryDirectory(prefix="vns-p1-09-prompt-key-ci-")

    def setup(self, root: str):
        source = Path(root) / "producer"
        target = Path(root) / "api"
        source.mkdir(mode=0o700)
        target.mkdir(mode=0o700)
        (source / custody.KEY).write_bytes(b"CI-not-a-real-key-material-32bytes")
        os.chmod(source / custody.KEY, 0o600)
        return source, target

    def test_exclusive_copy_and_read_only_verify_without_shared_inode(self):
        with self.environment() as directory:
            source, target = self.setup(directory)
            with patch.object(custody, "operator"), patch.object(
                custody, "SOURCE_DIR", source
            ), patch.object(custody, "TARGET_DIR", target):
                custody.preflight()
                custody.apply()
                custody.verify()
                a = (source / custody.KEY).stat()
                b = (target / custody.KEY).stat()
                self.assertEqual(stat.S_IMODE(b.st_mode), 0o600)
                self.assertEqual(b.st_nlink, 1)
                self.assertNotEqual((a.st_dev, a.st_ino), (b.st_dev, b.st_ino))
                self.assertEqual(
                    (source / custody.KEY).read_bytes(),
                    (target / custody.KEY).read_bytes(),
                )
                with self.assertRaises(FileExistsError):
                    custody.apply()
                self.assertEqual((target / custody.KEY).read_bytes(), b"CI-not-a-real-key-material-32bytes")

    def test_missing_source_symlink_and_wrong_permissions_denied(self):
        with self.environment() as directory:
            source, target = self.setup(directory)
            with patch.object(custody, "operator"), patch.object(
                custody, "SOURCE_DIR", source
            ), patch.object(custody, "TARGET_DIR", target):
                (source / custody.KEY).unlink()
                with self.assertRaises(FileNotFoundError):
                    custody.preflight()
                (source / custody.KEY).symlink_to(target / custody.KEY)
                with self.assertRaises(OSError):
                    custody.preflight()
                (source / custody.KEY).unlink()
                (source / custody.KEY).write_bytes(b"x" * 32)
                os.chmod(source / custody.KEY, 0o644)
                with self.assertRaises(PermissionError):
                    custody.preflight()
                os.chmod(source / custody.KEY, 0o600)
                os.chmod(target, 0o755)
                with self.assertRaises(PermissionError):
                    custody.preflight()

    def test_destination_mismatch_and_hardlink_are_denied(self):
        with self.environment() as directory:
            source, target = self.setup(directory)
            with patch.object(custody, "operator"), patch.object(
                custody, "SOURCE_DIR", source
            ), patch.object(custody, "TARGET_DIR", target):
                (target / custody.KEY).write_bytes(b"m" * 32)
                os.chmod(target / custody.KEY, 0o600)
                with self.assertRaises(RuntimeError):
                    custody.verify()
                with self.assertRaises(FileExistsError):
                    custody.apply()
                (target / custody.KEY).unlink()
                os.link(source / custody.KEY, target / custody.KEY)
                with self.assertRaises(PermissionError):
                    custody.verify()
                with self.assertRaises(FileExistsError):
                    custody.preflight()
                (target / custody.KEY).unlink()
                (target / custody.KEY).symlink_to(source / custody.KEY)
                with self.assertRaises(FileExistsError):
                    custody.preflight()

    def test_no_mutation_when_missing_explicit_approval(self):
        with patch.object(custody, "command", return_value="main"), patch.object(
            custody.os, "geteuid", return_value=1000
        ):
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError):
                    custody.operator(need_pin=True)

    def test_api_master_key_never_a_target(self):
        self.assertEqual(custody.KEY, "provider-prompt-key")
        self.assertEqual(custody.SOURCE_DIR.name, "vns-outbox")
        self.assertEqual(custody.TARGET_DIR.name, "vns")
        self.assertNotEqual(custody.SOURCE_DIR, custody.TARGET_DIR)


if __name__ == "__main__":
    unittest.main()
