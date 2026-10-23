import unittest

from check_compose import verify


def example():
    return {
        "services": {
            name: {
                "profiles": ["preview"],
                "cpus": 0.25,
                "mem_limit": 256 * 1024 * 1024,
                "networks": {"backend": {}},
                **({"command": ["redis-server", "--protected-mode", "yes"]} if name == "redis" else {}),
            }
            for name in ("web", "api", "worker", "postgres", "redis", "caddy")
        },
        "networks": {"backend": {"internal": True}},
        "secrets": {"postgres_password": {"file": "placeholder"}},
    }


class ComposePolicyTests(unittest.TestCase):
    def test_accepts_isolated_stack(self):
        self.assertTrue(verify(example()))

    def test_rejects_host_publishing(self):
        config = example()
        config["services"]["web"]["ports"] = [{"published": "8080", "target": 3000}]
        with self.assertRaisesRegex(ValueError, "publish ports"):
            verify(config)

    def test_rejects_missing_limit(self):
        config = example()
        del config["services"]["api"]["mem_limit"]
        with self.assertRaisesRegex(ValueError, "resource caps"):
            verify(config)

    def test_rejects_unisolated_backend(self):
        config = example()
        config["services"]["postgres"]["networks"] = {"frontend": {}}
        with self.assertRaisesRegex(ValueError, "non-backend"):
            verify(config)

    def test_rejects_insecure_redis(self):
        config = example()
        config["services"]["redis"]["command"][-1] = "no"
        with self.assertRaisesRegex(ValueError, "protected mode"):
            verify(config)


if __name__ == "__main__":
    unittest.main()
