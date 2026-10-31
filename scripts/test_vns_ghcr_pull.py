"""Local, offline safety tests for the non-persistent GHCR pull helper."""
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import vns_ghcr_pull as ghcr


IMAGE = "ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:" + "a" * 64
REVISION = "b" * 40
FAKE_TOKEN = "T" * 40


class GhcrPullTests(unittest.TestCase):
    def test_secret_permission_and_symlink_guards(self):
        with tempfile.TemporaryDirectory() as root:
            secrets = Path(root) / "secrets"
            secrets.mkdir(mode=0o700)
            directory = secrets / "ghcr"
            directory.mkdir(mode=0o700)
            token_file = directory / "readonly_pat"
            token_file.write_text(FAKE_TOKEN + "\n")
            token_file.chmod(0o600)
            self.assertEqual(ghcr.read_token(token_file), FAKE_TOKEN)
            token_file.chmod(0o644)
            with self.assertRaises(ValueError):
                ghcr.read_token(token_file)
            token_file.chmod(0o600)
            directory.chmod(0o755)
            with self.assertRaises(ValueError):
                ghcr.read_token(token_file)
            directory.chmod(0o700)
            token_file.unlink()
            token_file.symlink_to(Path(root) / "missing")
            with self.assertRaises(OSError):
                ghcr.read_token(token_file)

    def test_temporary_config_never_contains_token(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            ghcr.prepare_ephemeral_config(directory)
            config = directory / "config.json"
            wrapper = directory / "docker-credential-vnsghcr"
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o700)
            self.assertEqual(json.loads(config.read_text()),
                             {"credHelpers": {"ghcr.io": "vnsghcr"}})
            self.assertNotIn(FAKE_TOKEN, config.read_text() + wrapper.read_text())
            self.assertIn("--credential-helper", wrapper.read_text())

    def test_helper_rejects_any_non_ghcr_registry(self):
        with (
            patch.dict(os.environ, {"VNS_GHCR_HELPER_ALLOWED": "1"}),
            patch("sys.stdin", io.TextIOWrapper(io.BytesIO(b"docker.io"))),
        ):
            with patch.object(ghcr, "read_token") as read:
                self.assertEqual(ghcr.credential_helper(["get"]), 1)
                read.assert_not_called()

    def test_helper_emits_credentials_only_on_its_private_pipe(self):
        output = io.StringIO()
        with (
            patch.dict(os.environ, {"VNS_GHCR_HELPER_ALLOWED": "1"}),
            patch("sys.stdin", io.TextIOWrapper(io.BytesIO(b"ghcr.io"))),
            patch("sys.stdout", output),
            patch.object(ghcr, "read_token", return_value=FAKE_TOKEN),
        ):
            self.assertEqual(ghcr.credential_helper(["get"]), 0)
        self.assertEqual(json.loads(output.getvalue()),
                         {"Username": "whiteyOnTheMoon", "Secret": FAKE_TOKEN})

    def test_helper_rejects_direct_use(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(ghcr, "read_token") as read:
                self.assertEqual(ghcr.credential_helper(["get"]), 1)
                read.assert_not_called()

    def test_successful_pull_verifies_both_digest_and_revision(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if "pull" in args:
                self.assertIs(kwargs["stdout"], __import__("subprocess").DEVNULL)
                self.assertIs(kwargs["stderr"], __import__("subprocess").DEVNULL)
                cfg = Path(kwargs["env"]["DOCKER_CONFIG"])
                self.assertTrue((cfg / "config.json").exists())
                return SimpleNamespace(returncode=0)
            if ".RepoDigests" in args[-1]:
                return SimpleNamespace(returncode=0, stdout=json.dumps([IMAGE]))
            return SimpleNamespace(returncode=0, stdout=REVISION + "\n")

        out = io.StringIO()
        with patch.object(ghcr, "read_token", return_value=FAKE_TOKEN), \
             patch.object(ghcr.subprocess, "run", side_effect=fake_run), \
             contextlib.redirect_stdout(out):
            self.assertEqual(ghcr.pull(IMAGE, REVISION), 0)
        self.assertEqual(len(calls), 3)
        self.assertIn("PASS:", out.getvalue())
        self.assertNotIn(FAKE_TOKEN, out.getvalue())

    def test_pull_failure_prevents_inspect_and_no_token_in_output(self):
        with patch.object(ghcr, "read_token", return_value=FAKE_TOKEN), \
             patch.object(ghcr.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run, \
             contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(ghcr.pull(IMAGE, REVISION), 1)
            self.assertEqual(run.call_count, 1)
            self.assertNotIn(FAKE_TOKEN, error.getvalue())

    def test_rejects_tag_based_or_unexpected_images_before_secret_read(self):
        with patch.object(ghcr, "read_token") as read, contextlib.redirect_stderr(io.StringIO()):
            for image in ("ghcr.io/whiteyonthemoon/videonews-studio-web:latest",
                          "ghcr.io/another/repo@sha256:" + "a" * 64,
                          "ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:123"):
                self.assertEqual(ghcr.pull(image, REVISION), 2)
            read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
