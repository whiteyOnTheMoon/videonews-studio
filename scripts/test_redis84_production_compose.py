import copy
import unittest

from check_redis84_production_compose import IMAGE, VOLUME, verify


def fixture():
    redis = {
        "image": "redis:7-alpine",
        "volumes": [{"source": "redis_data", "target": "/data"}],
        "command": ["redis-server", "--protected-mode", "yes"],
        "secrets": [
            {"source": "redis_acl", "target": "/run/secrets/redis_acl"}
        ],
        "networks": {"backend": None},
    }
    base = {
        "services": {
            "redis": redis,
            "worker": {"image": "vns-worker:local"},
            "postgres": {"image": "postgres:17-alpine"},
        },
        "volumes": {"redis_data": {}},
    }
    prod = copy.deepcopy(base)
    prod["services"]["redis"]["image"] = IMAGE
    prod["services"]["redis"]["volumes"][0]["source"] = VOLUME
    prod["volumes"][VOLUME] = {}
    return base, prod


class RedisProductionGuardTests(unittest.TestCase):
    def test_valid_override(self):
        self.assertTrue(verify(*fixture()))

    def test_reject_redis_7(self):
        base, prod = fixture()
        prod["services"]["redis"]["image"] = "redis:7-alpine"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_unpinned_image(self):
        base, prod = fixture()
        prod["services"]["redis"]["image"] = "redis:8.4.8-alpine"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_old_data_volume(self):
        base, prod = fixture()
        prod["services"]["redis"]["volumes"][0]["source"] = "redis_data"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_other_service_changes(self):
        base, prod = fixture()
        prod["services"]["worker"]["image"] = "unexpected"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_public_port(self):
        base, prod = fixture()
        prod["services"]["redis"]["ports"] = [{"published": 6379}]
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_missing_acl(self):
        base, prod = fixture()
        prod["services"]["redis"]["secrets"] = []
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_wrong_acl_source(self):
        base, prod = fixture()
        prod["services"]["redis"]["secrets"][0]["source"] = "other_secret"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_wrong_acl_target(self):
        base, prod = fixture()
        prod["services"]["redis"]["secrets"][0]["target"] = "/tmp/redis_acl"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_string_instead_of_normalized_secret(self):
        base, prod = fixture()
        prod["services"]["redis"]["secrets"] = ["redis_acl"]
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_disabled_protected_mode(self):
        base, prod = fixture()
        prod["services"]["redis"]["command"][-1] = "no"
        with self.assertRaises(ValueError):
            verify(base, prod)

    def test_reject_extra_redis_change(self):
        base, prod = fixture()
        prod["services"]["redis"]["restart"] = "no"
        with self.assertRaises(ValueError):
            verify(base, prod)


if __name__ == "__main__":
    unittest.main()
