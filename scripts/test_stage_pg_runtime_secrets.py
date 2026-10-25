import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch

from stage_pg_runtime_secrets import NAMES, stage


class PgRuntimeSecretStageTests(unittest.TestCase):
    def test_creates_three_distinct_private_values(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "secrets"
            stage(folder, expected_uid=os.geteuid())
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
            values = []
            for name in NAMES:
                file = folder / name
                self.assertFalse(file.is_symlink())
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
                self.assertEqual(file.stat().st_uid, os.geteuid())
                value = file.read_text()
                self.assertTrue(re.fullmatch(r"[A-Za-z0-9_-]{40,}\n", value))
                values.append(value)
            self.assertEqual(len(set(values)), 3)

    def test_refuses_existing_files_without_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "secrets"
            stage(folder, expected_uid=os.geteuid())
            before = [(folder / name).read_bytes() for name in NAMES]
            with self.assertRaises(FileExistsError):
                stage(folder, expected_uid=os.geteuid())
            self.assertEqual(before, [(folder / name).read_bytes() for name in NAMES])

    def test_partial_existing_secret_refuses_and_preserves_existing(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "secrets"
            folder.mkdir(mode=0o700)
            (folder / NAMES[1]).write_text("preserve", encoding="utf8")
            with self.assertRaises(FileExistsError):
                stage(folder, expected_uid=os.geteuid())
            self.assertEqual((folder / NAMES[1]).read_text(), "preserve")
            self.assertFalse((folder / NAMES[0]).exists())

    def test_refuses_symlink_and_world_readable_directory(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            target = base / "real"
            target.mkdir(mode=0o700)
            link = base / "secrets"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(PermissionError):
                stage(link, expected_uid=os.geteuid())
            target.chmod(0o755)
            with self.assertRaises(PermissionError):
                stage(target, expected_uid=os.geteuid())

    def test_refuses_incorrect_operator_identity(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(PermissionError):
                stage(Path(root) / "secrets", expected_uid=os.geteuid() + 1)

    def test_rolls_back_new_files_after_generation_failure(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "secrets"
            with patch(
                "stage_pg_runtime_secrets.secrets.token_urlsafe",
                side_effect=["x" * 64, RuntimeError("simulated")],
            ):
                with self.assertRaises(RuntimeError):
                    stage(folder, expected_uid=os.geteuid())
            self.assertTrue(all(not (folder / name).exists() for name in NAMES))


if __name__ == "__main__":
    unittest.main()
