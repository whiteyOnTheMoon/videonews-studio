#!/usr/bin/env python3
"""Unpause-only, tightly constrained **synthetic VPS lab** helper.

Never targets the production Redis, even if a production container ID is
passed. No pause/start/stop/restart/rm/copy/network commands are available.
Run as ap under the user's independent systemd timer only after setup and
identity verification. A success here is not a production watchdog approval.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

from p2_02_redis8_unpause_watchdog_policy import (
    ExpectedTarget, IMAGE, classify, unpause_verified,
)

ROOT = Path("/home/ap/www/videonews-studio")
DATA = Path("/run/user/1000/vns-p2-redis-watchdog-lab-20261111-data")
NAME = "vns-p2-redis-watchdog-lab-20261111"
REFUSED = "REFUSED: synthetic VPS unpause lab admission"
SHAFULL = re.compile(r"[a-f0-9]{40}\Z")
IDFULL = re.compile(r"[a-f0-9]{64}\Z")
IMAGEID = re.compile(r"sha256:[a-f0-9]{64}\Z")


def command(args: list[str], *, limit: int = 131072, timeout: int = 15) -> str:
    try:
        process = subprocess.run(
            args, text=True, capture_output=True, check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None
    if (process.returncode or len(process.stdout) > limit
            or len(process.stderr) > 4096):
        raise RuntimeError(REFUSED)
    return process.stdout.strip()


def assert_checkout(sha: str) -> None:
    if not SHAFULL.fullmatch(sha):
        raise RuntimeError(REFUSED)
    if (os.getuid() != 1000 or getpass.getuser() != "ap"
            or not ROOT.is_dir()):
        raise RuntimeError(REFUSED)
    git = ["git", "-C", str(ROOT), "--no-optional-locks"]
    if (command(git + ["rev-parse", "HEAD"], limit=100) != sha
            or command(git + ["branch", "--show-current"], limit=100) != "main"
            or command(git + ["status", "--porcelain"], limit=2048)):
        raise RuntimeError(REFUSED)
    if command(["loginctl", "show-user", "ap", "-p", "Linger", "--value"],
               limit=32) != "yes":
        raise RuntimeError(REFUSED)


def target_for(container_id: str, image_id: str) -> ExpectedTarget:
    if not IDFULL.fullmatch(container_id) or not IMAGEID.fullmatch(image_id):
        raise RuntimeError(REFUSED)
    return ExpectedTarget(
        id=container_id, name=NAME, image_ref=IMAGE, image_id=image_id,
        project="vns-p2-synthetic", service="redis",
        mount_type="bind", mount_identity=str(DATA),
    )


def inspect(container_id: str) -> dict:
    reply = command(["docker", "inspect", container_id])
    result = json.loads(reply)
    if not isinstance(result, list) or len(result) != 1:
        raise RuntimeError(REFUSED)
    return result[0]


def check_only_synthetic(raw: dict, expected: ExpectedTarget) -> None:
    status = classify(raw, expected)
    host = raw["HostConfig"]
    config = raw["Config"]
    networks = raw["NetworkSettings"].get("Networks")
    if (host.get("NetworkMode") != "none"
            or host.get("ReadonlyRootfs") is not True
            or host.get("Privileged") is not False
            or "ALL" not in (host.get("CapDrop") or [])
            or config.get("User") != "1000:1000"
            or networks not in ({}, {"none": networks.get("none")} if isinstance(networks, dict) and "none" in networks else {})):
        raise RuntimeError(REFUSED)
    if status not in ("paused", "running"):
        raise RuntimeError(REFUSED)


def strict_read(container_id: str, expected: ExpectedTarget) -> dict:
    raw = inspect(container_id)
    check_only_synthetic(raw, expected)
    return raw


def run(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        description="Fail-closed unpause-only synthetic Redis VPS lab",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--release", action="store_true")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--image-id", required=True)
    args = parser.parse_args(argv)

    assert_checkout(args.expected_sha)
    target = target_for(args.container_id, args.image_id)
    st = DATA.lstat()
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid()
            or stat.S_IMODE(st.st_mode) != 0o700):
        raise RuntimeError(REFUSED)

    read = lambda cid: strict_read(cid, target)
    state = classify(read(target.id), target)
    if args.check:
        print("LAB_TARGET_EXACT_ID_VERIFIED=true")
        print("LAB_CONTAINER_STATE=" + state)
        print("PRODUCTION_TARGET_ADMITTED=false")
        return
    result = unpause_verified(
        target, read, lambda cid: command(["docker", "unpause", cid],
                                          limit=128, timeout=15),
    )
    if not result["identity_verified"]:
        raise RuntimeError(REFUSED)
    print("LAB_UNPAUSE_POLICY_PASS=true")
    print("LAB_RUNNING_AFTER_UNPAUSE=true")
    print("PRODUCTION_TARGET_ADMITTED=false")


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except (OSError, ValueError, KeyError, TypeError, AssertionError,
            RuntimeError, json.JSONDecodeError):
        raise SystemExit(REFUSED) from None
