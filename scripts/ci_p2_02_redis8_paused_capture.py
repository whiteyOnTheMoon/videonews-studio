#!/usr/bin/env python3
"""CI-only experiment: capture a PAUSED, synthetic Redis 8 AOF to an independent copy.

No VPS, production secrets, real volume, network attachment, worker or Compose.
A pause would temporarily interrupt the production queue, so this experiment
NEVER approves production use. A future live design must have a separate,
independent, bounded unpause watchdog capable of surviving operator failure.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

from p2_02_redis8_offline_archive import (
    compare_with_independent_inventory, inspect_archive,
)

IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
RUN = os.environ.get("GITHUB_RUN_ID", "")
if not (
    os.environ.get("GITHUB_ACTIONS") == "true"
    and os.environ.get("CI") == "true"
    and os.environ.get("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
    and os.environ.get("VNS_P2_REDIS8_PAUSE_CI") == "true"
    and re.fullmatch(r"[0-9]{1,20}", RUN)
):
    raise SystemExit("REFUSED: synthetic GitHub Actions pause test only")

SRC = "vns-p2-aof-pause-src-" + RUN
DST = "vns-p2-aof-pause-dst-" + RUN
REFUSED = "REFUSED: synthetic paused AOF capture test incomplete"


def docker(*args: str, allow_error: bool = False, timeout: int = 40) -> str:
    try:
        result = subprocess.run(
            ["docker", *args], capture_output=True, text=True,
            check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None
    if result.returncode != 0 and not allow_error:
        raise RuntimeError(REFUSED)
    if len(result.stdout) > 8192 or len(result.stderr) > 8192:
        raise RuntimeError(REFUSED)
    return result.stdout.strip()


def start(name: str, data: Path) -> None:
    docker(
        "run", "--rm", "-d", "--name", name,
        "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--memory", "144m", "--memory-swap", "144m",
        "--cpus", "0.3", "--pids-limit", "64",
        "--tmpfs", "/tmp:rw,nosuid,noexec,size=8m",
        "--mount", f"type=bind,src={data},dst=/data",
        IMAGE,
        "redis-server", "--protected-mode", "yes",
        "--bind", "127.0.0.1", "--appendonly", "yes",
        "--aof-load-truncated", "no", "--save", "", "--dir", "/data",
        "--maxmemory", "96mb", "--maxmemory-policy", "noeviction",
        timeout=160,
    )
    for _ in range(45):
        if docker("exec", name, "redis-cli", "ping", allow_error=True) == "PONG":
            return
        time.sleep(1)
    raise RuntimeError(REFUSED)


def write_probe(name: str, key: str, member: str, score: int) -> None:
    reply = docker("exec", name, "redis-cli", "--raw", "ZADD", key,
                   str(score), member)
    if reply != "1":
        raise RuntimeError(REFUSED)


def assert_probe(name: str, key: str, member: str, score: int) -> None:
    reply = docker("exec", name, "redis-cli", "--raw", "ZSCORE", key, member)
    if reply != str(score):
        raise RuntimeError(REFUSED)


def main() -> None:
    p1 = "bull:vns:vns-jobs:completed"
    p2 = "bull:vns:feed:vns-feed-poll:completed"
    with tempfile.TemporaryDirectory(prefix="vns-p2-aof-pause-ci-") as tmp:
        source, copy = Path(tmp) / "source", Path(tmp) / "independent"
        source.mkdir(mode=0o700)
        paused = False
        try:
            start(SRC, source)
            write_probe(SRC, p1, "ci-p1-before-pause", 12345)
            write_probe(SRC, p2, "ci-p2-before-pause", 67890)
            assert_probe(SRC, p1, "ci-p1-before-pause", 12345)
            assert_probe(SRC, p2, "ci-p2-before-pause", 67890)

            # Only CI disposable source is paused. This has NO VPS path.
            docker("pause", SRC)
            paused = True
            if docker("inspect", "--format", "{{.State.Paused}}", SRC) != "true":
                raise RuntimeError(REFUSED)
            captured_at = time.monotonic()
            inventory = inspect_archive(source)
            shutil.copytree(source, copy, symlinks=True)
            compare_with_independent_inventory(copy, inventory)
            if time.monotonic() - captured_at > 10:
                raise RuntimeError(REFUSED)
        finally:
            # Cleanup is best-effort on CI only. NOT a production watchdog.
            if paused:
                docker("unpause", SRC, allow_error=True)
            docker("rm", "-f", SRC, allow_error=True)

        try:
            # The source is removed; destination is the only writable replay data.
            compare_with_independent_inventory(copy, inventory)
            start(DST, copy)
            assert_probe(DST, p1, "ci-p1-before-pause", 12345)
            assert_probe(DST, p2, "ci-p2-before-pause", 67890)
            print("PASS: CI-only paused-source capture retained synthetic P1/P2 data")
            print("PASS: independent copy recovered under Redis 8.4.8 with no network")
            print("LIMIT: no live Redis freeze permitted, no independent unpause watchdog")
        finally:
            docker("rm", "-f", DST, allow_error=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, AssertionError):
        raise SystemExit(REFUSED) from None
