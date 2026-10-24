import copy
import unittest

from p1_07_readiness import check


def valid():
    service = {"profiles": ["data"], "mem_limit": 100, "cpus": 0.3}
    services = {name: dict(service) for name in ("web", "api", "worker", "postgres", "redis")}
    services["worker"].update({"networks": {"backend": None}, "restart": "no"})
    services["postgres"].update({
        "networks": {"backend": None},
        "environment": {"POSTGRES_PASSWORD_FILE": "/run/secrets/postgres_password"},
        "secrets": [{"source": "postgres_password"}],
    })
    services["redis"].update({
        "networks": {"backend": None},
        "command": ["redis-server", "--aclfile", "/run/secrets/redis_acl", "--protected-mode", "yes"],
        "secrets": [{"source": "redis_acl"}],
    })
    return {"services": services, "networks": {"backend": {"internal": True}}, "secrets": {"redis_acl": {}}}


def overlay():
    data = valid()
    data["services"]["worker"].update({
        "profiles": ["worker"],
        "restart": "unless-stopped",
        "environment": {
            "VNS_WORKER_ENABLED": "true",
            "VNS_REDIS_HOST": "redis",
            "VNS_REDIS_PORT": "6379",
            "VNS_REDIS_PASSWORD_FILE": "/run/secrets/redis_password",
        },
        "secrets": [{"source": "redis_password"}],
        "depends_on": {"redis": {"condition": "service_healthy", "required": True}},
    })
    data["secrets"]["redis_password"] = {"file": "/runner/project/secrets/redis_password"}
    return data


class ReadinessTests(unittest.TestCase):
    def test_valid(self):
        check(valid())

    def test_no_backend_isolation(self):
        data = valid()
        data["networks"]["backend"]["internal"] = False
        with self.assertRaisesRegex(ValueError, "internal"):
            check(data)

    def test_no_host_ports(self):
        data = valid()
        data["services"]["redis"]["ports"] = ["6379:6379"]
        with self.assertRaisesRegex(ValueError, "host exposure"):
            check(data)

    def test_no_extra_network(self):
        data = valid()
        data["services"]["postgres"]["networks"]["frontend"] = None
        with self.assertRaisesRegex(ValueError, "backend network"):
            check(data)

    def test_no_inline_pg_password(self):
        data = valid()
        data["services"]["postgres"]["environment"] = {"POSTGRES_PASSWORD": "not-allowed"}
        with self.assertRaisesRegex(ValueError, "password"):
            check(data)

    def test_no_pg_secret(self):
        data = valid()
        data["services"]["postgres"]["secrets"] = []
        with self.assertRaisesRegex(ValueError, "secret"):
            check(data)

    def test_redis_protected_mode_required(self):
        data = valid()
        data["services"]["redis"]["command"][-1] = "no"
        with self.assertRaisesRegex(ValueError, "protected mode"):
            check(data)

    def test_no_redis_acl_file(self):
        data = valid()
        data["services"]["redis"]["command"].remove("/run/secrets/redis_acl")
        with self.assertRaisesRegex(ValueError, "ACL"):
            check(data)

    def test_worker_overlay_requires_exact_credentials_and_health(self):
        check(overlay(), worker_overlay=True)
        with self.assertRaisesRegex(ValueError, "scaffold worker"):
            check(overlay())

    def test_worker_overlay_rejects_disabled_flag(self):
        data = overlay()
        data["services"]["worker"]["environment"]["VNS_WORKER_ENABLED"] = "false"
        with self.assertRaisesRegex(ValueError, "authentication"):
            check(data, worker_overlay=True)

    def test_worker_overlay_rejects_secret_and_acl_drift(self):
        data = overlay()
        data["services"]["worker"]["secrets"] = []
        with self.assertRaisesRegex(ValueError, "mount only"):
            check(data, worker_overlay=True)
        data = overlay()
        data["secrets"]["redis_password"]["file"] = "/runner/other/password"
        with self.assertRaisesRegex(ValueError, "file-backed"):
            check(data, worker_overlay=True)
        data = overlay()
        data["services"]["redis"]["secrets"] = []
        with self.assertRaisesRegex(ValueError, "Redis must require"):
            check(data, worker_overlay=True)

    def test_worker_overlay_rejects_network_and_startup_changes(self):
        data = overlay()
        data["services"]["worker"]["profiles"] = ["preview"]
        with self.assertRaisesRegex(ValueError, "opt-in"):
            check(data, worker_overlay=True)
        data = overlay()
        data["services"]["worker"]["depends_on"]["redis"]["condition"] = "service_started"
        with self.assertRaisesRegex(ValueError, "healthy"):
            check(data, worker_overlay=True)
        data = overlay()
        data["services"]["worker"]["ports"] = ["3000:3000"]
        with self.assertRaisesRegex(ValueError, "host exposure"):
            check(data, worker_overlay=True)

    def test_worker_must_not_autorestart(self):
        data = valid()
        data["services"]["worker"]["restart"] = "unless-stopped"
        with self.assertRaisesRegex(ValueError, "scaffold worker"):
            check(data)


if __name__ == "__main__":
    unittest.main()
