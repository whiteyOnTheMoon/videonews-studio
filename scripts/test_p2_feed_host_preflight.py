"""Synthetic tests: never touch real production secrets or require root."""

import stat
import unittest
from types import SimpleNamespace
from pathlib import Path

from p2_feed_host_preflight import (
    MAX_SIGNED_BYTES,
    RULES,
    WORKER_UID,
    PreflightDenied,
    inspect_feed_host,
)


def synthetic_host():
    env = {"VNS_P2_TRANSFER_UID": "10003"}
    metadata = {}
    for rule in RULES:
        path = "/opt/vns-ci/" + rule.name.lower()
        env[rule.name] = path
        mode = stat.S_IFDIR if rule.kind == "directory" else stat.S_IFREG
        metadata[path] = SimpleNamespace(
            st_mode=mode | rule.permissions,
            st_uid=10003 if rule.uid == -1 else rule.uid,
            st_gid=rule.gid,
            st_nlink=1,
            st_size=4096 if rule.kind == "directory" else 128,
        )
    stage = str(Path(env["VNS_P2_HANDOFF_STAGING_DIR"]) / "source-export.signed.json")
    inbox = str(Path(env["VNS_P2_WORKER_INBOX_DIR"]) / "source-export.signed.json")
    checkpoint = str(
        Path(env["VNS_P2_WORKER_CHECKPOINT_DIR"]) / "source-export.checkpoint.json"
    )
    metadata[stage] = SimpleNamespace(
        st_mode=stat.S_IFREG | 0o640,
        st_uid=10003,
        st_gid=WORKER_UID,
        st_nlink=1,
        st_size=220,
    )
    for item in (inbox, checkpoint):
        metadata[item] = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600,
            st_uid=WORKER_UID,
            st_gid=WORKER_UID,
            st_nlink=1,
            st_size=220,
        )

    def inspect(path):
        if path not in metadata:
            raise FileNotFoundError()
        return metadata[path]

    return env, metadata, inspect, stage, inbox, checkpoint


class HostReleasePreflightTests(unittest.TestCase):
    def test_all_three_stages_only_inspect_metadata(self):
        env, metadata, inspect, stage, inbox, checkpoint = synthetic_host()
        self.assertEqual(inspect_feed_host(env, "prepare", inspect), len(RULES))
        self.assertEqual(inspect_feed_host(env, "handoff", inspect), len(RULES) + 1)
        self.assertEqual(inspect_feed_host(env, "observer", inspect), len(RULES) + 3)
        self.assertEqual(metadata[stage].st_size, 220)
        self.assertEqual(metadata[inbox].st_size, 220)
        self.assertEqual(metadata[checkpoint].st_size, 220)

    def test_missing_secrets_bad_paths_aliases_and_transfer_uids_fail_closed(self):
        env, metadata, inspect, *_ = synthetic_host()
        variants = [
            {**env, "VNS_P2_SIGNER_DB_PASSWORD_FILE": ""},
            {**env, "VNS_P2_PRIVATE_SIGNING_KEY_FILE": "/tmp/../tmp/key"},
            {**env, "VNS_P2_WORKER_INBOX_DIR": env["VNS_P2_PUBLISHER_DIR"]},
            {**env, "VNS_P2_TRANSFER_UID": "0"},
            {**env, "VNS_P2_TRANSFER_UID": "10002"},
            {**env, "VNS_P2_TRANSFER_UID": "10001"},
            {**env, "VNS_P2_TRANSFER_UID": "10002.5"},
            {**env, "VNS_P2_TRANSFER_UID": ""},
        ]
        for bad in variants:
            with self.subTest(bad=bad), self.assertRaises(PreflightDenied):
                inspect_feed_host(bad, "prepare", inspect)
        with self.assertRaises(PreflightDenied):
            inspect_feed_host(env, "unknown", inspect)
        env.pop("VNS_P2_PRIVATE_SIGNING_KEY_FILE")
        with self.assertRaises(PreflightDenied):
            inspect_feed_host(env, "prepare", inspect)

    def test_permissions_ownership_file_type_and_hardlinks_refused(self):
        for update in [
            {"st_mode": stat.S_IFREG | 0o640},
            {"st_mode": stat.S_IFLNK | 0o400},
            {"st_uid": 10002},
            {"st_gid": 0},
            {"st_nlink": 2},
            {"st_size": 0},
        ]:
            env, metadata, inspect, *_ = synthetic_host()
            key = env["VNS_P2_PRIVATE_SIGNING_KEY_FILE"]
            for field, value in update.items():
                setattr(metadata[key], field, value)
            with self.subTest(update=update), self.assertRaises(PreflightDenied):
                inspect_feed_host(env, "prepare", inspect)

    def test_stage_and_worker_files_need_exact_owners_modes_and_byte_limits(self):
        for which, replacement in [
            ("stage", {"st_mode": stat.S_IFREG | 0o666}),
            ("stage", {"st_uid": 10002}),
            ("stage", {"st_nlink": 2}),
            ("stage", {"st_size": MAX_SIGNED_BYTES + 1}),
            ("inbox", {"st_mode": stat.S_IFREG | 0o644}),
            ("checkpoint", {"st_uid": 0}),
            ("checkpoint", {"st_size": MAX_SIGNED_BYTES + 1}),
        ]:
            env, metadata, inspect, stage, inbox, checkpoint = synthetic_host()
            path = {"stage": stage, "inbox": inbox, "checkpoint": checkpoint}[which]
            for field, value in replacement.items():
                setattr(metadata[path], field, value)
            phase = "handoff" if which == "stage" else "observer"
            with self.subTest(which=which, replacement=replacement):
                with self.assertRaises(PreflightDenied):
                    inspect_feed_host(env, phase, inspect)
                if phase == "observer":
                    # Earlier preparation is not invalidated by the later file.
                    self.assertEqual(inspect_feed_host(env, "prepare", inspect), len(RULES))

    def test_unprovisioned_staging_is_detected_by_phase(self):
        env, metadata, inspect, stage, *_ = synthetic_host()
        del metadata[stage]
        self.assertEqual(inspect_feed_host(env, "prepare", inspect), len(RULES))
        with self.assertRaises(PreflightDenied):
            inspect_feed_host(env, "handoff", inspect)


if __name__ == "__main__":
    unittest.main()
