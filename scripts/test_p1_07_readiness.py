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
        "command": ["redis-server", "--protected-mode", "yes"],
    })
    return {"services": services, "networks": {"backend": {"internal": True}}}


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

    def test_worker_must_not_autorestart(self):
        data = valid()
        data["services"]["worker"]["restart"] = "unless-stopped"
        with self.assertRaisesRegex(ValueError, "scaffold worker"):
            check(data)


if __name__ == "__main__":
    unittest.main()
