"""Synthetic-only tests for Redis 8 offline AOF archive validation."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_02_redis8_offline_archive as proof


BASE = "appendonly.aof.1.base.rdb"
INCR = "appendonly.aof.1.incr.aof"
GOOD = (
    f"file {BASE} seq 1 type b\n"
    f"file {INCR} seq 1 type i\n"
)


class ArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="vns-offline-aof-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "copied"
        self.part = self.root / "appendonlydir"
        self.part.mkdir(parents=True)
        (self.part / proof.MANIFEST).write_text(GOOD, encoding="ascii")
        (self.part / BASE).write_bytes(b"synthetic-base-data")
        (self.part / INCR).write_bytes(b"synthetic-increment-data")

    def test_valid_two_segments(self) -> None:
        result = proof.inspect_archive(self.root)
        self.assertEqual(len(result["files"]), 3)
        self.assertGreater(result["total_bytes"], 0)
        self.assertEqual(result["format"], "vns-redis8-offline-archive-v1")

    def test_identical_independent_copy(self) -> None:
        inventory = proof.inspect_archive(self.root)
        second = Path(self.temp.name) / "separate"
        shutil.copytree(self.root, second)
        self.assertEqual(
            proof.compare_with_independent_inventory(second, inventory),
            {"layout_checked": True, "inventory_match": True,
             "read_only": True, "restore_verified": False},
        )

    def test_tampered_segment_refused(self) -> None:
        reference = proof.inspect_archive(self.root)
        (self.part / INCR).write_bytes(b"synthetic-tampered-content")
        with self.assertRaises(ValueError):
            proof.compare_with_independent_inventory(self.root, reference)

    def test_changed_reference_refused(self) -> None:
        reference = proof.inspect_archive(self.root)
        reference["files"][0]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            proof.compare_with_independent_inventory(self.root, reference)

    def test_missing_segment_refused(self) -> None:
        (self.part / INCR).unlink()
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_extra_segment_refused(self) -> None:
        (self.part / "appendonly.aof.2.incr.aof").write_bytes(b"extra")
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_symlink_refused(self) -> None:
        (self.part / BASE).unlink()
        (self.part / BASE).symlink_to(self.part / INCR)
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_hardlink_refused(self) -> None:
        extra = Path(self.temp.name) / "linked"
        os.link(self.part / INCR, extra)
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_manifest_wrong_sequence_refused(self) -> None:
        (self.part / proof.MANIFEST).write_text(
            GOOD.replace(f"{INCR} seq 1", f"{INCR} seq 2"), encoding="ascii"
        )
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_manifest_path_traversal_refused(self) -> None:
        (self.part / proof.MANIFEST).write_text(
            GOOD.replace(INCR, "../outside"), encoding="ascii"
        )
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_manifest_duplicate_refused(self) -> None:
        (self.part / proof.MANIFEST).write_text(
            GOOD + f"file {INCR} seq 1 type i\n", encoding="ascii"
        )
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_manifest_without_trailing_newline_refused(self) -> None:
        (self.part / proof.MANIFEST).write_bytes(GOOD.rstrip().encode("ascii"))
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_unexpected_root_file_refused(self) -> None:
        (self.root / "old-dump.rdb").write_bytes(b"nonempty")
        with self.assertRaises(ValueError):
            proof.inspect_archive(self.root)

    def test_multiple_incrementals_allowed(self) -> None:
        extra = "appendonly.aof.2.incr.aof"
        (self.part / extra).write_bytes(b"second-increment")
        (self.part / proof.MANIFEST).write_text(
            GOOD + f"file {extra} seq 2 type i\n", encoding="ascii"
        )
        self.assertEqual(len(proof.inspect_archive(self.root)["files"]), 4)

    def test_invalid_inventory_shape_refused(self) -> None:
        for bad in ({}, [], {"files": []}, None):
            with self.subTest(inventory=type(bad).__name__):
                with self.assertRaises(ValueError):
                    proof.compare_with_independent_inventory(self.root, bad)

    def test_directory_symlink_refused(self) -> None:
        link = Path(self.temp.name) / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            proof.inspect_archive(link)


if __name__ == "__main__":
    unittest.main()
