#!/usr/bin/env python3
"""P2-04 local-build operator checks; never build or modify Docker in CI."""
from pathlib import Path
import subprocess
import unittest

SCRIPT = Path(__file__).with_name("p2_04_bounded_local_app_build.sh")


class BoundedBuildAdmission(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT.read_text("utf-8")

    def test_bash_syntax(self):
        p = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True,
                           text=True, timeout=5)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_invalid_arguments_refuse_before_accessing_docker(self):
        for args in (
            [],
            ["--expected-sha", "invalid"],
            ["--expected-sha", "a" * 39],
            ["--run", "a" * 40],
        ):
            with self.subTest(args=args):
                p = subprocess.run(["bash", str(SCRIPT), *args],
                                   capture_output=True, text=True, timeout=5)
                self.assertEqual(p.returncode, 2)
                self.assertIn("REFUSED:", p.stderr)

    def test_dedicated_bounded_builder_not_default(self):
        s = self.script
        for expected in (
            '--driver docker-container',
            "'memory=2048m,memory-swap=2048m,restart-policy=no'",
            'max-parallelism = 1',
            "'2147483648|2147483648|no'",
            '--builder "$BUILDER"',
            '--platform linux/amd64',
            '--load --progress plain',
            'CREATED=false',
            'docker buildx rm --force "$BUILDER"',
            'docker buildx inspect "$BUILDER" --bootstrap',
        ):
            self.assertIn(expected, s)
        self.assertNotIn("docker build --", s)
        self.assertNotIn("--builder default", s)

    def test_refuses_low_ram_swap_disk_and_unexpected_images(self):
        s = self.script
        for required in (
            'disk >= 16*1024*1024', 'mem >= 3500*1024',
            'swap >= 256*1024', 'resources',
            'docker image inspect "$API"',
            'docker image inspect "$WEB"',
            'docker inspect --format',
            'State.StartedAt',
            'git --no-optional-locks status --porcelain',
            "'1000:1000:600:1:regular file'",
            'git rev-parse HEAD',
            'docker info --format',
        ):
            self.assertIn(required, s)

    def test_no_deployment_upload_or_other_service_changes(self):
        s = self.script
        for forbidden in (
            'docker compose up', 'docker compose down',
            'docker start', 'docker restart', 'docker stop',
            'docker system prune', 'docker image prune',
            'docker push', '--push', 'docker login',
            'ghcr.io/', 'curl ', 'wget ', 'redis-cli',
            'rsync ', 'scp ',
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, s)
        self.assertIn("for target in api web; do", s)
        self.assertEqual(s.count('docker buildx build --builder "$BUILDER"'), 1)


if __name__ == "__main__":
    unittest.main()
