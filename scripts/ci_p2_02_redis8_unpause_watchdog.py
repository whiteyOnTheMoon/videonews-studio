#!/usr/bin/env python3
"""CI-only networkless Redis watchdog-unpause proof on a disposable container.

This is NOT the systemd scheduler, and it cannot start on VPS. It confirms
a strict identity mismatch never unpauses an unrelated/synthetic Redis and
that an allowed exact-ID target is released and re-inspected correctly.
"""
from __future__ import annotations

from dataclasses import replace
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from p2_02_redis8_unpause_watchdog_policy import (
    ExpectedTarget, IMAGE, unpause_verified,
)

RUN = os.environ.get("GITHUB_RUN_ID", "")
if not (
    os.environ.get("GITHUB_ACTIONS") == "true"
    and os.environ.get("CI") == "true"
    and os.environ.get("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
    and os.environ.get("VNS_P2_REDIS8_WATCHDOG_CI") == "true"
    and re.fullmatch(r"[0-9]{1,20}", RUN)
):
    raise SystemExit("REFUSED: synthetic GitHub Actions watchdog only")

NAME = "vns-p2-ci-unpause-" + RUN
FAIL = "REFUSED: synthetic watchdog unpause proof failed"


def docker(*args: str, allow_error: bool = False, timeout: int = 35) -> str:
    try:
        result = subprocess.run(
            ["docker", *args], capture_output=True, text=True,
            check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(FAIL) from None
    if (result.returncode != 0 and not allow_error
            or len(result.stdout) > 40000
            or len(result.stderr) > 4000):
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def inspect(identifier: str) -> dict:
    reply = docker("inspect", identifier)
    result = json.loads(reply)
    if not isinstance(result, list) or len(result) != 1:
        raise RuntimeError(FAIL)
    return result[0]


def unpause(identifier: str) -> None:
    docker("unpause", identifier)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="vns-p2-unpause-ci-") as tmp:
        root = Path(tmp)
        try:
            docker(
                "run", "-d", "--rm", "--name", NAME,
                "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges:true",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "--memory", "128m", "--memory-swap", "128m",
                "--cpus", "0.3", "--pids-limit", "64",
                "--tmpfs", "/tmp:rw,nosuid,noexec,size=8m",
                "--label", "com.docker.compose.project=vns-p2-synthetic",
                "--label", "com.docker.compose.service=redis",
                "--mount", f"type=bind,src={root},dst=/data",
                IMAGE,
                "redis-server", "--protected-mode", "yes",
                "--bind", "127.0.0.1", "--appendonly", "no",
                "--save", "", "--dir", "/data",
                timeout=160,
            )
            for _ in range(45):
                if docker("exec", NAME, "redis-cli", "ping",
                          allow_error=True) == "PONG":
                    break
                time.sleep(1)
            else:
                raise RuntimeError(FAIL)
            original = inspect(NAME)
            target = ExpectedTarget(
                id=original["Id"], name=NAME, image_ref=IMAGE,
                image_id=original["Image"],
                project="vns-p2-synthetic", service="redis",
                mount_type="bind", mount_identity=str(root),
            )
            docker("pause", NAME)
            if inspect(NAME).get("State", {}).get("Paused") is not True:
                raise RuntimeError(FAIL)
            # A fabricated other container ID must not invoke Docker unpause.
            try:
                unpause_verified(replace(target, id="a" * 64),
                                 lambda _: inspect(NAME),
                                 lambda _: (_ for _ in ()).throw(RuntimeError(FAIL)))
            except ValueError:
                pass
            else:
                raise RuntimeError(FAIL)
            if inspect(NAME).get("State", {}).get("Paused") is not True:
                raise RuntimeError(FAIL)
            result = unpause_verified(target, inspect, unpause)
            if (not result["unpause_attempted"]
                    or inspect(NAME).get("State", {}).get("Paused") is not False):
                raise RuntimeError(FAIL)
            repeated = unpause_verified(target, inspect, unpause)
            if not repeated["already_running"] or repeated["unpause_attempted"]:
                raise RuntimeError(FAIL)
            print("PASS: wrong-ID unpause was refused on synthetic container")
            print("PASS: exact-ID isolated Redis container resumed and re-inspected")
            print("PASS: second check made no Docker state change")
            print("LIMIT: no systemd timer, logout resilience or production permit tested")
        finally:
            # Release only the synthetic, CI-owned container before deleting it.
            docker("unpause", NAME, allow_error=True)
            docker("rm", "-f", NAME, allow_error=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, RuntimeError,
            AssertionError, json.JSONDecodeError):
        raise SystemExit(FAIL) from None
