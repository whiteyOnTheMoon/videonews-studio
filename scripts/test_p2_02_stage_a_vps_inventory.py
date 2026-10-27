"""Deterministic negative tests. No Docker, VPS or git subprocess is invoked."""
import unittest
from types import SimpleNamespace

from p2_02_stage_a_vps_inventory import inspect_stage_a

EXPECTED = "9d94f348ca491adffacd958fa14520cff8487f7b"
PROJECT = "videonews-studio"


def fake_runner(*, checkout=EXPECTED, status="", docker=None, docker_ok=True, git_ok=True):
    calls = []
    output = docker if docker is not None else (
        "postgres|running|Up 1h (healthy)|5432/tcp\n"
        "redis|running|Up 1h (healthy)|6379/tcp\n"
        "feed-consumer|running|Up 1h (healthy)|\n"
    )

    def run(argv, cwd):
        calls.append((tuple(argv), cwd))
        if argv[:2] == ["git", "rev-parse"]:
            return (0, checkout + "\n") if git_ok else (128, "PRIVATE GIT ERROR")
        if argv[:2] == ["git", "status"]:
            return (0, status) if git_ok else (128, "PRIVATE GIT ERROR")
        if argv[:2] == ["docker", "ps"]:
            return (0, output) if docker_ok else (125, "DOCKER SECRET ERROR")
        raise AssertionError("Unexpected command")

    return run, calls


def capacity(_):
    return SimpleNamespace(f_blocks=100, f_bavail=33, f_frsize=1024**3)


class StageAReadOnlyTests(unittest.TestCase):
    def inspect(self, run, **kwargs):
        return inspect_stage_a(
            repo_dir="/home/ap/www/videonews-studio",
            expected_sha=EXPECTED,
            run=run,
            free_space=capacity,
            **kwargs,
        )

    def test_healthy_inventory_is_reviewable_but_not_production_approval(self):
        run, calls = fake_runner()
        report = self.inspect(run)
        self.assertEqual(report["stage_a_readiness"], "reviewable")
        self.assertFalse(report["production_authorized"])
        self.assertEqual(report["docker"]["services"]["feed-consumer"]["health"], "healthy")
        self.assertEqual(report["docker"]["services"]["feed-producer-continuous"]["state"], "not_observed")
        self.assertEqual(report["resources"]["root_available_gib"], 33)
        self.assertEqual(len(calls), 3)
        for argv, _ in calls:
            self.assertNotIn("inspect", argv)
            self.assertNotIn("exec", argv)
            self.assertNotIn("config", argv)
            self.assertNotIn("start", argv)
            self.assertNotIn("up", argv)
            self.assertNotIn("logs", argv)
        self.assertEqual(
            calls[2][0][4],
            "label=com.docker.compose.project=" + PROJECT,
        )

    def test_mismatched_commit_or_tracked_changes_block(self):
        for kwargs in ({"checkout": "a" * 40}, {"status": " M apps/worker/src/index.ts\n"}, {"git_ok": False}):
            with self.subTest(kwargs=kwargs):
                run, _ = fake_runner(**kwargs)
                report = self.inspect(run)
                self.assertEqual(report["stage_a_readiness"], "blocked")
                self.assertFalse(report["production_authorized"])

    def test_wrong_project_containers_do_not_leak_raw_names_or_secrets(self):
        secret = "SECRET_SUPER_LONG_API_TOKEN"
        output = (
            "some-third-party|running|" + secret + "|127.0.0.1:9900->9900/tcp\n"
            "feed-consumer|exited|Exited (2) " + secret + "|\n"
        )
        run, _ = fake_runner(docker=output)
        report = self.inspect(run)
        self.assertEqual(report["docker"]["services"]["feed-consumer"]["state"], "exited")
        self.assertNotIn(secret, str(report))
        self.assertNotIn("some-third-party", str(report))
        self.assertFalse(report["production_authorized"])

    def test_concurrent_producers_and_exposed_ports_block(self):
        for docker in (
            "feed-scheduler|running|Up 1m|\nfeed-producer-continuous|running|Up 1m|\n",
            "feed-producer-continuous|running|Up 1m (healthy)|0.0.0.0:9999->9999/tcp\n",
            "feed-consumer|running|Up 1m|\nfeed-consumer|restarting|Restarting|\n",
        ):
            with self.subTest(docker=docker):
                run, _ = fake_runner(docker=docker)
                report = self.inspect(run)
                self.assertEqual(report["stage_a_readiness"], "blocked")

    def test_no_docker_access_is_unknown_not_no_containers(self):
        run, _ = fake_runner(docker_ok=False)
        report = self.inspect(run)
        self.assertFalse(report["docker"]["accessible"])
        self.assertEqual(report["stage_a_readiness"], "blocked")
        self.assertFalse(report["checks"]["no_feed_host_ports"])

    def test_bad_release_project_and_repo_inputs_refused(self):
        run, _ = fake_runner()
        for field, value in (
            ("expected_sha", "main"),
            ("expected_sha", "a" * 39),
            ("project_name", ";rm -rf /"),
            ("repo_dir", "../../tmp"),
            ("repo_dir", "/tmp/../etc"),
        ):
            args = {
                "repo_dir": "/home/ap/www/videonews-studio",
                "expected_sha": EXPECTED,
                "run": run,
                "free_space": capacity,
            }
            args[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                inspect_stage_a(**args)


if __name__ == "__main__":
    unittest.main()
