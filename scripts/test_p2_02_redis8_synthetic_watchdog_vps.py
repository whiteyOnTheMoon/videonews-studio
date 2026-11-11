"""CI-only fake-inspect tests for the synthetic VPS watchdog caller."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_02_redis8_synthetic_watchdog_vps as lab


def fixture():
    target = lab.target_for("a" * 64, "sha256:" + "b" * 64)
    raw = {
        "Id": target.id, "Name": "/" + target.name,
        "Image": target.image_id,
        "Config": {
            "Image": lab.IMAGE, "User": "1000:1000",
            "Labels": {
                "com.docker.compose.project": "vns-p2-synthetic",
                "com.docker.compose.service": "redis",
            },
        },
        "State": {
            "Running": True, "Paused": True,
            "Status": "paused", "Dead": False, "Restarting": False,
        },
        "HostConfig": {
            "NetworkMode": "none", "ReadonlyRootfs": True,
            "Privileged": False, "CapDrop": ["ALL"], "PortBindings": {},
        },
        "NetworkSettings": {
            "Ports": {"6379/tcp": None}, "Networks": {"none": {}},
        },
        "Mounts": [{
            "Destination": "/data", "Type": "bind",
            "Source": str(lab.DATA), "RW": True,
        }],
    }
    return target, raw


class SyntheticVpsWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.target, self.raw = fixture()

    def test_valid_paused(self):
        lab.check_only_synthetic(self.raw, self.target)

    def test_valid_running(self):
        self.raw["State"].update(Paused=False, Status="running")
        lab.check_only_synthetic(self.raw, self.target)

    def test_wrong_image_id_is_denied(self):
        self.raw["Image"] = "sha256:" + "c" * 64
        with self.assertRaises(ValueError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_cannot_target_production_name(self):
        self.raw["Name"] = "/videonews-studio-redis-1"
        with self.assertRaises(ValueError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_cannot_target_production_volume(self):
        self.raw["Mounts"][0].update(
            Type="volume", Name="videonews-studio_redis_p109_restored"
        )
        with self.assertRaises(ValueError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_wrong_label_is_denied(self):
        self.raw["Config"]["Labels"]["com.docker.compose.project"] = "videonews-studio"
        with self.assertRaises(ValueError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_network_bridge_is_denied(self):
        self.raw["HostConfig"]["NetworkMode"] = "bridge"
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_extra_network_is_denied(self):
        self.raw["NetworkSettings"]["Networks"]["bridge"] = {}
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_mutable_rootfs_is_denied(self):
        self.raw["HostConfig"]["ReadonlyRootfs"] = False
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_privileged_is_denied(self):
        self.raw["HostConfig"]["Privileged"] = True
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_missing_cap_drop_is_denied(self):
        self.raw["HostConfig"]["CapDrop"] = []
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_wrong_user_is_denied(self):
        self.raw["Config"]["User"] = "0:0"
        with self.assertRaises(RuntimeError):
            lab.check_only_synthetic(self.raw, self.target)

    def test_invalid_ids_are_denied(self):
        for cid, image_id in [
            ("bad", self.target.image_id),
            ("a" * 64, "nope"),
            ("a" * 64, "sha256:" + "q" * 64),
        ]:
            with self.subTest(cid=cid[:8], image_id=image_id[:12]):
                with self.assertRaises(RuntimeError):
                    lab.target_for(cid, image_id)

    def test_read_inspection_is_id_based_only(self):
        with patch.object(lab, "command", return_value="[{}]") as mock:
            self.assertEqual(lab.inspect(self.target.id), {})
            mock.assert_called_once_with(["docker", "inspect", self.target.id])

    def test_live_release_is_not_invoked_by_check(self):
        with patch.object(lab, "inspect", return_value=deepcopy(self.raw)):
            with patch.object(lab, "command") as mock:
                # Classification and metadata validation never mutates.
                lab.check_only_synthetic(lab.inspect(self.target.id), self.target)
                mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
