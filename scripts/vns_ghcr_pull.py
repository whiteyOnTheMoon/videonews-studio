#!/usr/bin/env python3
"""Read-only GHCR credential helper for one digest-pinned Docker image pull.

No docker login, Docker credential persistence, Compose or container operations.
A temporary Docker config contains only a credential-helper name, never a token.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / "secrets" / "ghcr" / "readonly_pat"
IMAGE_RE = re.compile(
    r"ghcr\.io/whiteyonthemoon/videonews-studio-(?:web|api)"
    r"@sha256:[0-9a-f]{64}\Z"
)
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")


def _private_directory(path: Path, *, exact_mode: int | None = None) -> None:
    metadata = path.lstat()  # Reject symlinks, including parent secret directories.
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise ValueError("Unsafe GHCR secret directory")
    mode = stat.S_IMODE(metadata.st_mode)
    if exact_mode is not None and mode != exact_mode:
        raise ValueError("Unsafe GHCR secret directory permissions")
    if mode & 0o022:
        raise ValueError("Group/other-writable GHCR secret directory")


def read_token(path: Path = TOKEN_FILE) -> str:
    _private_directory(path.parent.parent)  # Existing secrets/ directory.
    _private_directory(path.parent, exact_mode=0o700)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ValueError("Unsafe GHCR token permissions or file type")
        raw = os.read(fd, 258)
    finally:
        os.close(fd)
    if raw.endswith(b"\n"):
        raw = raw[:-1]
    try:
        token = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValueError("Invalid GHCR token encoding") from exc
    if not re.fullmatch(r"[A-Za-z0-9_]{30,256}", token):
        raise ValueError("Invalid GHCR token format")
    return token


def credential_helper(argv: list[str]) -> int:
    # The Docker CLI invokes this process via the temporary helper wrapper.
    # Only 'get' is supported; no token is ever stored by a credential manager.
    if argv != ["get"]:
        return 1
    server = sys.stdin.buffer.read(1025)
    if len(server) > 1024 or server.strip() not in (b"ghcr.io", b"https://ghcr.io"):
        return 1
    try:
        token = read_token()
    except (OSError, ValueError):
        return 1
    # Credentials travel directly to Docker's credential-helper pipe,
    # not to the operator terminal or any on-disk Docker config.
    json.dump({"Username": "whiteyOnTheMoon", "Secret": token}, sys.stdout)
    return 0


def prepare_ephemeral_config(directory: Path) -> None:
    helper = directory / "docker-credential-vnsghcr"
    wrapper = (
        "#!/bin/sh\nexec "
        + shlex.quote(sys.executable)
        + " -I "
        + shlex.quote(str(Path(__file__).resolve()))
        + ' --credential-helper "$@"\n'
    )
    fd = os.open(helper, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(wrapper)
    config = directory / "config.json"
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump({"credHelpers": {"ghcr.io": "vnsghcr"}}, stream)


def verify_image(image: str, revision: str) -> None:
    def inspect(fmt: str) -> str:
        result = subprocess.run(
            ["docker", "image", "inspect", image, "--format", fmt],
            text=True, capture_output=True, check=False, timeout=30,
        )
        if result.returncode:
            raise ValueError("Image inspection failed")
        return result.stdout.strip()

    digests = json.loads(inspect("{{json .RepoDigests}}"))
    if not isinstance(digests, list) or image not in digests:
        raise ValueError("Image does not match its pinned repository digest")
    found_revision = inspect(
        '{{index .Config.Labels "org.opencontainers.image.revision"}}'
    )
    if found_revision != revision:
        raise ValueError("Image revision label does not match expected release")


def pull(image: str, revision: str) -> int:
    if not IMAGE_RE.fullmatch(image) or not SHA_RE.fullmatch(revision):
        print("BLOCKED: require a GHCR web/api SHA-256 digest and a full release SHA", file=sys.stderr)
        return 2
    try:
        # Validate the local secret without disclosing it.
        read_token()
        # The helper and config contain no token; even abrupt SIGKILL cannot
        # leave Docker auth material in the temporary directory.
        with tempfile.TemporaryDirectory(prefix="vns-ghcr-pull-") as folder:
            directory = Path(folder)
            prepare_ephemeral_config(directory)
            env = os.environ.copy()
            env["DOCKER_CONFIG"] = folder
            env["PATH"] = folder + os.pathsep + env.get("PATH", "")
            result = subprocess.run(
                ["docker", "--config", folder, "pull", image],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=900,
            )
            if result.returncode:
                raise ValueError("Authenticated GHCR image pull failed")
        verify_image(image, revision)
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired, InterruptedError, KeyboardInterrupt):
        print("BLOCKED: GHCR pull/verification failed; no deployment performed", file=sys.stderr)
        return 1
    print("PASS: digest-pinned GHCR image present; release revision verified")
    print("No Docker login persisted; no container or Compose changes performed")
    return 0


def _on_signal(_signum: int, _frame: object) -> None:
    raise InterruptedError("Interrupted pull")


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--credential-helper":
        return credential_helper(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="exact ghcr.io/...-(web|api)@sha256:digest")
    parser.add_argument("revision", help="exact 40-character source commit SHA")
    args = parser.parse_args(argv)
    signal.signal(signal.SIGHUP, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    return pull(args.image, args.revision)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
