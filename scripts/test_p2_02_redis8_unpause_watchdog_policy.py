"""Synthetic-only tests for exact-ID Redis unpause watchdog contract."""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_02_redis8_unpause_watchdog_policy as policy


def fixtures() -> tuple[policy.ExpectedTarget, dict]:
    target = policy.ExpectedTarget(
        id="a" * 64, name="vns-p2-ci-redis",
        image_ref=policy.IMAGE, image_id="sha256:" + "b" * 64,
        project="vns-p2-synthetic", service="redis",
        mount_type="bind", mount_identity="/tmp/synthetic-fixture",
    )
    snapshot = {
        "Id": target.id, "Name": "/" + target.name,
        "Image": target.image_id,
        "Config": {
            "Image": target.image_ref,
            "Labels": {
                "com.docker.compose.project": target.project,
                "com.docker.compose.service": target.service,
            },
        },
        "State": {
            "Running": True, "Paused": True,
            "Restarting": False, "Dead": False,
            "Status": "paused",
        },
        "Mounts": [{
            "Destination": "/data",
            "Type": "bind", "Source": target.mount_identity,
            "RW": True,
        }],
        "HostConfig": {"PortBindings": {}},
        "NetworkSettings": {"Ports": {"6379/tcp": None}},
    }
    return target, snapshot


class WatchdogPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target, self.snapshot = fixtures()

    def test_paused_identity_accepted(self) -> None:
        self.assertEqual(policy.classify(self.snapshot, self.target), "paused")

    def test_running_identity_accepted(self) -> None:
        self.snapshot["State"].update(Status="running", Paused=False)
        self.assertEqual(policy.classify(self.snapshot, self.target), "running")

    def test_wrong_container_id_refused(self) -> None:
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, replace(self.target, id="c" * 64))

    def test_wrong_image_refused(self) -> None:
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, replace(
                self.target, image_id="sha256:" + "c" * 64
            ))

    def test_wrong_name_refused(self) -> None:
        self.snapshot["Name"] = "/other"
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_wrong_volume_refused(self) -> None:
        self.snapshot["Mounts"][0]["Source"] = "/tmp/unrelated"
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_label_mismatch_refused(self) -> None:
        self.snapshot["Config"]["Labels"]["com.docker.compose.project"] = "other"
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_published_port_refused(self) -> None:
        self.snapshot["HostConfig"]["PortBindings"] = {
            "6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6379"}]
        }
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_network_port_published_refused(self) -> None:
        self.snapshot["NetworkSettings"]["Ports"] = {
            "6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6379"}]
        }
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_dead_target_refused(self) -> None:
        self.snapshot["State"].update(Running=False, Status="exited")
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_missing_network_metadata_refused(self) -> None:
        self.snapshot["NetworkSettings"] = None
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, self.target)

    def test_production_name_requires_exact_approved_source(self) -> None:
        invalid = replace(self.target, name=policy.CONTAINER)
        with self.assertRaises(ValueError):
            policy.classify(self.snapshot, invalid)

    def test_unpause_exact_pinned_id_only(self) -> None:
        snapshot = deepcopy(self.snapshot)
        called = []

        def read(identifier):
            self.assertEqual(identifier, self.target.id)
            return deepcopy(snapshot)

        def unpause(identifier):
            self.assertEqual(identifier, self.target.id)
            called.append(identifier)
            snapshot["State"].update(Paused=False, Status="running")

        result = policy.unpause_verified(self.target, read, unpause)
        self.assertEqual(called, [self.target.id])
        self.assertTrue(result["unpause_attempted"])

    def test_already_running_never_unpause(self) -> None:
        self.snapshot["State"].update(Paused=False, Status="running")
        result = policy.unpause_verified(
            self.target, lambda _: self.snapshot,
            lambda _: self.fail("unexpected docker unpause"),
        )
        self.assertTrue(result["already_running"])
        self.assertFalse(result["unpause_attempted"])

    def test_wrong_id_never_unpause(self) -> None:
        with self.assertRaises(ValueError):
            policy.unpause_verified(
                replace(self.target, id="c" * 64),
                lambda _: self.snapshot,
                lambda _: self.fail("unexpected docker unpause"),
            )

    def test_postcheck_still_paused_refused(self) -> None:
        calls = []
        with self.assertRaises(ValueError):
            policy.unpause_verified(
                self.target, lambda _: self.snapshot,
                lambda identifier: calls.append(identifier),
            )
        self.assertEqual(calls, [self.target.id])


if __name__ == "__main__":
    unittest.main()
