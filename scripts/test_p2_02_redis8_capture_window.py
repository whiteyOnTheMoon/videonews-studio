"""Synthetic-only tests; never connect to VPS, Redis or Docker."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_02_redis8_capture_window as gate


def sample() -> dict:
    def record(name: str, inode: int) -> dict:
        return {
            "name": name,
            "device": 12,
            "inode": inode,
            "size": 1048,
            "mtime_ns": 1000000000,
            "ctime_ns": 1000000000,
            "sha256": "a" * 64,
        }

    return {
        "container_id": "b" * 64,
        "image": gate.EXPECTED_IMAGE,
        "volume": gate.EXPECTED_VOLUME,
        "uptime_seconds": 100,
        "aof": {
            "aof_enabled": 1,
            "aof_rewrite_in_progress": 0,
            "aof_rewrite_scheduled": 0,
            "aof_rewrites": 3,
            "aof_current_size": 9000000,
            "aof_base_size": 8000000,
            "aof_pending_bio_fsync": 0,
            "aof_last_bgrewrite_status": "ok",
            "aof_last_write_status": "ok",
        },
        "files": [
            record("appendonly.aof.manifest", 10),
            record("appendonly.aof.3.base.rdb", 11),
            record("appendonly.aof.3.incr.aof", 12),
        ],
    }


class CaptureWindowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.before = sample()
        self.after = deepcopy(self.before)
        self.after["uptime_seconds"] += 2

    def assert_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "REFUSED"):
            gate.assess_window(self.before, self.after)

    def test_observations_stable_but_no_permission(self) -> None:
        result = gate.assess_window(self.before, self.after)
        self.assertTrue(result["observation_stable"])
        for claim in (
            "point_in_time_consistency_proven",
            "independent_backup_verified",
            "isolated_redis_replay_verified",
            "production_capture_authorized",
            "redis_only_cutover_authorized",
        ):
            self.assertFalse(result[claim])

    def test_additional_incremental_segment_allowed(self) -> None:
        extra = deepcopy(self.before["files"][-1])
        extra.update(name="appendonly.aof.4.incr.aof", inode=13)
        self.before["files"].append(extra)
        self.after["files"].append(deepcopy(extra))
        self.assertTrue(gate.assess_window(self.before, self.after)["observation_stable"])

    def test_any_rewrite_activity_refused(self) -> None:
        for field in ("aof_rewrite_in_progress", "aof_rewrite_scheduled"):
            for side in ("before", "after"):
                with self.subTest(field=field, side=side):
                    first, last = deepcopy(self.before), deepcopy(self.after)
                    (first if side == "before" else last)["aof"][field] = 1
                    with self.assertRaises(ValueError):
                        gate.assess_window(first, last)

    def test_bad_persistence_status_refused(self) -> None:
        for field in ("aof_last_bgrewrite_status", "aof_last_write_status"):
            with self.subTest(field=field):
                self.after["aof"][field] = "err"
                self.assert_refused()
                self.after["aof"][field] = "ok"

    def test_rewrite_counter_change_refused(self) -> None:
        self.after["aof"]["aof_rewrites"] += 1
        self.assert_refused()

    def test_aof_current_size_change_refused(self) -> None:
        self.after["aof"]["aof_current_size"] += 1
        self.assert_refused()

    def test_aof_base_size_change_refused(self) -> None:
        self.after["aof"]["aof_base_size"] += 1
        self.assert_refused()

    def test_fsync_pending_refused(self) -> None:
        self.before["aof"]["aof_pending_bio_fsync"] = 1
        self.assert_refused()

    def test_replaced_inode_refused(self) -> None:
        self.after["files"][1]["inode"] = 777
        self.assert_refused()

    def test_changed_contents_digest_refused(self) -> None:
        self.after["files"][0]["sha256"] = "c" * 64
        self.assert_refused()

    def test_changed_timestamp_refused(self) -> None:
        self.after["files"][-1]["mtime_ns"] += 1
        self.assert_refused()

    def test_missing_manifest_refused(self) -> None:
        self.before["files"].pop(0)
        self.assert_refused()

    def test_missing_base_refused(self) -> None:
        self.before["files"].pop(1)
        self.assert_refused()

    def test_duplicate_file_refused(self) -> None:
        self.before["files"].append(deepcopy(self.before["files"][-1]))
        self.assert_refused()

    def test_wrong_volume_refused(self) -> None:
        self.after["volume"] = "videonews-studio_redis_data"
        self.assert_refused()

    def test_wrong_image_refused(self) -> None:
        self.after["image"] = "redis:latest"
        self.assert_refused()

    def test_container_changed_refused(self) -> None:
        self.after["container_id"] = "c" * 64
        self.assert_refused()

    def test_uptime_regressed_refused(self) -> None:
        self.after["uptime_seconds"] = 99
        self.assert_refused()

    def test_bool_instead_of_int_refused(self) -> None:
        self.after["aof"]["aof_rewrite_scheduled"] = False
        self.assert_refused()

    def test_incomplete_observation_refused(self) -> None:
        del self.before["aof"]["aof_rewrites"]
        self.assert_refused()


if __name__ == "__main__":
    unittest.main()
