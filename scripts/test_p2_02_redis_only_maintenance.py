"""Pure offline security regression tests for the read-only Redis-only operator."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import p2_02_redis_only_maintenance as m
from test_redis84_production_compose import fixture as redis84_fixture


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "secrets").mkdir()
        (self.root / "secrets/redis_acl").write_text("user default off\n")
        self.source = str(self.root / "secrets/redis_acl")
        base, prod = redis84_fixture()
        self.definition = prod["services"]["redis"]
        self.definition["image"] = m.IMAGE
        self.definition["command"] = ["redis-server", "--protected-mode", "yes"]
        self.image_id = "sha256:ci-only-image-id"
        self.host_inode = (100, 22)
        self.stale_inode = (100, 21)
        self.live = {
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "videonews-studio",
                    "com.docker.compose.service": "redis",
                },
                "Image": m.IMAGE,
                "Cmd": copy.deepcopy(self.definition["command"]),
            },
            "Image": self.image_id,
            "Mounts": [
                {
                    "Destination": "/run/secrets/redis_acl",
                    "Source": self.source,
                    "Type": "bind", "RW": False,
                },
                {
                    "Destination": "/data",
                    "Name": m.VOLUME, "Type": "volume", "RW": True,
                },
            ],
            "NetworkSettings": {
                "Networks": {m.NETWORK: {"IPAddress": "172.25.0.3"}},
                "Ports": {"6379/tcp": None},
            },
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "RestartCount": 0,
        }
        self.patch_root = patch.object(m, "ROOT", self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)

    def assess(self, inode=None, live=None, definition=None, image_id=None, free=None):
        return m.redis_assessment(
            definition or self.definition,
            live or self.live,
            image_id or self.image_id,
            inode if inode is not None else self.stale_inode,
            self.host_inode,
            free if free is not None else 12 * 1024**3,
        )

    def test_stale_acl_inode_means_preflight_only(self):
        self.assertFalse(self.assess()["acl_mount_current_inode"])
        self.assertTrue(self.assess(self.host_inode)["acl_mount_current_inode"])

    def test_reject_wrong_image_and_digest(self):
        for value in ("redis:7-alpine", "redis:8.4.8-alpine", m.IMAGE + "-bad"):
            c = copy.deepcopy(self.live)
            c["Config"]["Image"] = value
            with self.assertRaises(RuntimeError):
                self.assess(live=c)
        with self.assertRaises(RuntimeError):
            self.assess(image_id="sha256:wrong-image-id")

    def test_reject_wrong_or_missing_data_mount(self):
        for mutated in ("wrong", "bind", "missing"):
            c = copy.deepcopy(self.live)
            if mutated == "wrong":
                c["Mounts"][1]["Name"] = "videonews-studio_redis_data"
            elif mutated == "bind":
                c["Mounts"][1]["Type"] = "bind"
            else:
                c["Mounts"].pop()
            with self.assertRaises(RuntimeError):
                self.assess(live=c)

    def test_reject_acl_secret_not_same_exact_host_file(self):
        for mutation in ("RW", "Type", "Source", "missing", "duplicate"):
            c = copy.deepcopy(self.live)
            if mutation == "RW":
                c["Mounts"][0]["RW"] = True
            elif mutation == "Type":
                c["Mounts"][0]["Type"] = "volume"
            elif mutation == "Source":
                c["Mounts"][0]["Source"] = "/tmp/unexpected-acl"
            elif mutation == "missing":
                c["Mounts"].pop(0)
            else:
                c["Mounts"].append(copy.deepcopy(c["Mounts"][0]))
            with self.assertRaises((RuntimeError, FileNotFoundError)):
                self.assess(live=c)

    def test_reject_nonprivate_network_and_host_exposure(self):
        c = copy.deepcopy(self.live)
        c["NetworkSettings"]["Ports"]["6379/tcp"] = [{"HostPort": "6379"}]
        with self.assertRaises(RuntimeError):
            self.assess(live=c)
        c = copy.deepcopy(self.live)
        c["NetworkSettings"]["Networks"]["bridge"] = {}
        with self.assertRaises(RuntimeError):
            self.assess(live=c)

    def test_reject_unhealthy_or_restarting_or_wrong_compose_identity(self):
        for edit in (
            lambda c: c["State"]["Health"].update({"Status": "unhealthy"}),
            lambda c: c.update({"RestartCount": 1}),
            lambda c: c["State"].update({"Running": False}),
            lambda c: c["Config"]["Labels"].update(
                {"com.docker.compose.service": "worker"}
            ),
            lambda c: c["Config"].update({"Cmd": ["redis-server", "--save", ""]}),
        ):
            c = copy.deepcopy(self.live)
            edit(c)
            with self.assertRaises(RuntimeError):
                self.assess(live=c)

    def test_reject_inadequate_disk_headroom(self):
        with self.assertRaises(RuntimeError):
            self.assess(free=8 * 1024**3 - 1)

    def test_operator_never_accepts_execute_or_rollback_action(self):
        for flag in ("--execute", "--recreate", "--rollback", "--install", "--acl-load"):
            with self.assertRaises(SystemExit):
                m.main([flag, "--expected-sha", "a" * 40])

    def test_verify_respects_stale_vs_current_and_readonly_postcheck_login(self):
        config = copy.deepcopy(self.live)
        st = os.stat(self.root / "secrets/redis_acl")
        inode = (st.st_dev, st.st_ino)
        with (
            patch.object(m, "require_checkout"),
            patch.object(m, "require_installed_acl"),
            patch.object(m, "require_compose", return_value=self.definition),
            patch.object(m, "inspect", return_value=config),
            patch.object(m, "check_service_quiescence"),
            patch.object(m, "command", side_effect=lambda args, **kwargs: {
                "docker network inspect": '[{"Internal":true}]',
                "docker volume ls": m.VOLUME + "\n" + m.LEGACY_VOLUME,
                "docker image inspect": self.image_id,
            }[" ".join(args[:3])]),
            patch.object(m, "inode_from_container", return_value=self.stale_inode) as inode_probe,
            patch.object(m, "read_private_status_password", return_value=b"fake-only-password"),
            patch.object(m, "check_status_auth") as auth,
            patch("os.statvfs", return_value=SimpleNamespace(
                f_bavail=12 * 1024**3, f_frsize=1
            )),
        ):
            result = m.verify("a" * 40)
            self.assertEqual(result["mode"], "preflight")
            self.assertFalse(result["maintenance_execution_authorized"])
            auth.assert_not_called()
            with self.assertRaises(RuntimeError):
                m.verify("a" * 40, postcheck=True)
            inode_probe.return_value = inode
            with self.assertRaises(RuntimeError):
                m.verify("a" * 40)
            result = m.verify("a" * 40, postcheck=True)
            self.assertEqual(result["mode"], "postcheck")
            self.assertTrue(result["studio_status_auth_and_foreign_key_denial"])
            auth.assert_called_once()
            auth.side_effect = RuntimeError("denied")
            with self.assertRaises(RuntimeError):
                m.verify("a" * 40, postcheck=True)

    def test_checkout_refuses_wrong_uid_sha_or_dirty_tree(self):
        with patch("os.getuid", return_value=1000), patch("os.geteuid", return_value=1000):
            with self.assertRaises(PermissionError):
                m.require_checkout("bad")
        with patch("os.getuid", return_value=1001):
            with self.assertRaises(PermissionError):
                m.require_checkout("a" * 40)
        with (
            patch("os.getuid", return_value=1000),
            patch("os.geteuid", return_value=1000),
            patch.object(m, "command", side_effect=["main", "a" * 40, " M secrets/redis_acl"]),
        ):
            with self.assertRaises(RuntimeError):
                m.require_checkout("a" * 40)

    def test_compose_uses_exact_three_files_and_two_profiles(self):
        with patch.object(m, "command", return_value='{"services":{}}') as cmd:
            self.assertEqual(m.render(m.FILES), {"services": {}})
            args = cmd.call_args.args[0]
            self.assertEqual(args[:6], [
                "docker", "compose", "--profile", "data", "--profile", "worker"
            ])
            self.assertEqual(args.count("-f"), 3)
            self.assertEqual(args[-3:], ["config", "--format", "json"])


if __name__ == "__main__":
    unittest.main()
