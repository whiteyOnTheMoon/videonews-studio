"""Synthetic read-only P2 inventory tests; no VPS, Docker or secret opens."""
import copy
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest

from p2_readonly_host_custody_report import (
    inspect_custody, inspect_host_status, SECRETS,
)

BASE = Path("/var/lib/videonews-studio")
SHA = "a" * 40


def fake_metadata():
    mapping = {}
    def item(path, directory, uid, gid, mode, size=100, links=1):
        mapping[str(path)] = SimpleNamespace(
            st_mode=(stat.S_IFDIR if directory else stat.S_IFREG) | mode,
            st_uid=uid, st_gid=gid, st_size=size, st_nlink=links,
        )
    item(BASE, True, 0, 0, 0o700)
    sec = BASE / "p2-feed-runtime-secrets"
    item(sec, True, 0, 0, 0o700)
    for name, uid in SECRETS.items():
        item(sec / name, False, uid, uid, 0o400, size=80)
    base = BASE / "p2-signed-source"
    item(base, True, 0, 0, 0o700)
    pub = base / "publisher"
    item(pub, True, 10001, 10001, 0o700)
    item(pub / "signing-private.pem", False, 10001, 10001, 0o400)
    item(pub / "source-export.signed.json", False, 10001, 10001, 0o600)
    trust = base / "trust-material"
    item(trust, True, 0, 0, 0o700)
    item(trust / "signing-public.pem", False, 0, 10002, 0o440)
    for name in ("worker-inbox", "worker-checkpoint"):
        item(base / name, True, 10002, 10002, 0o700)
    stage = base / "handoff-staging"
    item(stage, True, 10003, 10002, 0o750)
    item(stage / "source-export.signed.json", False, 10003, 10002, 0o640)
    item(base / "worker-inbox/source-export.signed.json", False, 10002, 10002, 0o600)
    item(base / "worker-checkpoint/source-export.checkpoint.json",
         False, 10002, 10002, 0o600)
    return mapping


def inspect(mapping, *, extra=None):
    def safe_stat(path):
        item = mapping.get(str(path))
        if item is None:
            raise FileNotFoundError()
        return item
    def safe_list(path):
        if str(path) == str(BASE / "p2-feed-runtime-secrets"):
            return list(SECRETS) + (extra or [])
        if str(path) == str(BASE / "p2-signed-source/handoff-staging"):
            return ["source-export.signed.json"]
        raise FileNotFoundError()
    return inspect_custody(base=BASE, inspect=safe_stat, listdir=safe_list)


def stage():
    return {
        "stage_a_readiness": "reviewable",
        "release": {
            "expected_sha": SHA, "checkout_sha": SHA,
            "tracked_worktree_clean": True,
        },
        "checks": {
            "expected_checkout_sha": True,
            "tracked_worktree_clean": True,
            "docker_inventory_accessible": True,
            "no_ambiguous_feed_containers": True,
            "no_feed_host_ports": True,
            "no_competing_feed_producers": True,
        },
    }


class CustodyTests(unittest.TestCase):
    def test_complete_only_metadata_report_is_never_production_authorization(self):
        custody = inspect(fake_metadata())
        self.assertEqual(len(custody), 7)
        self.assertTrue(all(custody.values()))
        result = inspect_host_status(
            expected_sha=SHA, stage=stage(), branch="main", custody=custody,
        )
        self.assertEqual(result["read_only_metadata_preflight"], "reviewable")
        self.assertFalse(result["production_authorized"])
        self.assertTrue(all(value == "not_verified"
                            for value in result["independent_evidence"].values()))
        self.assertNotIn("vns_feed_db_password", json.dumps(result))
        self.assertNotIn("source-export.signed.json", json.dumps(result))

    def test_before_operator_handoff_stage_and_checkpoint_are_not_invented(self):
        mapping = fake_metadata()
        for name in (
            "handoff-staging",
            "handoff-staging/source-export.signed.json",
            "worker-inbox/source-export.signed.json",
            "worker-checkpoint/source-export.checkpoint.json",
        ):
            del mapping[str(BASE / "p2-signed-source" / name)]
        result = inspect(mapping)
        self.assertTrue(result["runtime_secret_metadata"])
        self.assertTrue(result["publisher_file_metadata"])
        self.assertFalse(result["staging_file_metadata"])
        self.assertFalse(result["inbox_file_metadata"])
        self.assertFalse(result["local_checkpoint_file_metadata"])
        report = inspect_host_status(
            expected_sha=SHA, stage=stage(), branch="main", custody=result,
        )
        self.assertEqual(report["read_only_metadata_preflight"], "incomplete")

    def test_secret_extra_entries_symlink_perms_and_hardlinks_fail_closed(self):
        records = fake_metadata()
        self.assertFalse(inspect(records, extra=["unexpected"])["runtime_secret_metadata"])
        for name, mutate, expected in (
            (
                "p2-feed-runtime-secrets/vns_feed_db_password",
                lambda meta: setattr(meta, "st_nlink", 2), "runtime_secret_metadata"
            ),
            (
                "p2-signed-source/publisher/signing-private.pem",
                lambda meta: setattr(meta, "st_mode", stat.S_IFLNK | 0o400),
                "publisher_file_metadata",
            ),
            (
                "p2-signed-source/trust-material/signing-public.pem",
                lambda meta: setattr(meta, "st_gid", 10001), "public_key_file_metadata",
            ),
            (
                "p2-signed-source/handoff-staging",
                lambda meta: setattr(meta, "st_mode", stat.S_IFDIR | 0o777),
                "staging_file_metadata",
            ),
        ):
            edited = copy.deepcopy(records)
            mutate(edited[str(BASE / name)])
            self.assertFalse(inspect(edited)[expected], name)

    def test_bad_release_and_shape_never_report_reviewable(self):
        custody = inspect(fake_metadata())
        for branch, sample in (
            ("feature", stage()),
            ("main", {**stage(), "stage_a_readiness": "blocked"}),
            ("main", {**stage(), "release": {**stage()["release"],
                                            "checkout_sha": "b" * 40}}),
            ("main", {**stage(), "checks": {"no_feed_host_ports": False}}),
        ):
            report = inspect_host_status(
                expected_sha=SHA, stage=sample, branch=branch,
                custody=custody,
            )
            self.assertEqual(report["read_only_metadata_preflight"], "incomplete")
            self.assertFalse(report["production_authorized"])
        for wrong in ({**custody, "password": "secret"},
                      {**custody, "runtime_secret_metadata": 1}):
            with self.assertRaises(ValueError):
                inspect_host_status(
                    expected_sha=SHA, stage=stage(), branch="main",
                    custody=wrong,
                )


if __name__ == "__main__":
    unittest.main()
