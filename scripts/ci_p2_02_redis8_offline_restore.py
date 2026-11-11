#!/usr/bin/env python3
"""CI-only: restore an independent Redis 8 multipart AOF copy without networking.

No VPS support. No real credentials, real job content, live Docker volumes,
Compose stack, exposed host ports, ACL reloads, or production maintenance.
All Docker objects here are ephemeral GitHub Actions synthetic fixtures.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import p2_02_redis8_offline_archive as archive

IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
RUN = os.environ.get("GITHUB_RUN_ID", "")
if not (
    os.environ.get("GITHUB_ACTIONS") == "true"
    and os.environ.get("CI") == "true"
    and os.environ.get("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
    and os.environ.get("VNS_P2_REDIS8_RESTORE_CI") == "true"
    and re.fullmatch(r"[0-9]{1,20}", RUN)
):
    raise SystemExit("REFUSED: synthetic GitHub Actions replay only")

SOURCE = "vns-p2-redis8-source-" + RUN
TARGET = "vns-p2-redis8-target-" + RUN
REFUSED = "REFUSED: synthetic offline Redis 8 replay failed"


def docker(*args: str, allow_error: bool = False, timeout: int = 40) -> str:
    try:
        result = subprocess.run(
            ["docker", *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None
    if result.returncode != 0 and not allow_error:
        raise RuntimeError(REFUSED)
    if len(result.stdout) > 8192 or len(result.stderr) > 8192:
        raise RuntimeError(REFUSED)
    return result.stdout.strip()


def start(name: str, data: Path) -> None:
    # Explicitly mount an isolated CI directory, never a named Docker volume.
    docker(
        "run", "--rm", "-d", "--name", name,
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--memory", "144m", "--memory-swap", "144m",
        "--cpus", "0.3", "--pids-limit", "64",
        "--tmpfs", "/tmp:rw,nosuid,noexec,size=8m",
        "--mount", f"type=bind,src={data},dst=/data",
        IMAGE,
        "redis-server", "--protected-mode", "yes",
        "--bind", "127.0.0.1", "--appendonly", "yes",
        "--aof-load-truncated", "no",
        "--save", "", "--dir", "/data",
        "--maxmemory", "96mb", "--maxmemory-policy", "noeviction",
        timeout=160,
    )
    for _ in range(45):
        if docker("exec", name, "redis-cli", "ping", allow_error=True) == "PONG":
            return
        time.sleep(1)
    raise RuntimeError(REFUSED)


def data_matches(name: str) -> bool:
    # Known synthetic IDs only. Never dump or iterate real Redis contents.
    p1 = docker("exec", name, "redis-cli", "--raw", "ZSCORE",
                "bull:vns:vns-jobs:completed", "ci-p1")
    p2 = docker("exec", name, "redis-cli", "--raw", "ZSCORE",
                "bull:vns:feed:vns-feed-poll:completed", "ci-p2")
    return p1 == "12345" and p2 == "67890"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="vns-p2-redis8-restore-") as tmp:
        root = Path(tmp)
        source = root / "source"
        restored = root / "restored"
        source.mkdir(mode=0o700)
        try:
            print("CI_STAGE=source_start", flush=True)
            start(SOURCE, source)
            print("CI_STAGE=source_ready", flush=True)
            first = docker("exec", SOURCE, "redis-cli", "ZADD",
                           "bull:vns:vns-jobs:completed", "12345", "ci-p1")
            second = docker("exec", SOURCE, "redis-cli", "ZADD",
                            "bull:vns:feed:vns-feed-poll:completed", "67890", "ci-p2")
            if first != "1" or second != "1" or not data_matches(SOURCE):
                raise RuntimeError(REFUSED)
            print("CI_STAGE=source_seeded", flush=True)
            docker("stop", "--time", "15", SOURCE, timeout=35)
            print("CI_STAGE=source_stopped", flush=True)

            # Only an already stopped synthetic source is copied.
            inventory = archive.inspect_archive(source)
            print("CI_STAGE=source_inventory", flush=True)
            shutil.copytree(source, restored, symlinks=True)
            result = archive.compare_with_independent_inventory(restored, inventory)
            print("CI_STAGE=first_copy_validated", flush=True)
            if not (result["layout_checked"] and result["inventory_match"]):
                raise RuntimeError(REFUSED)

            # Reject tampering *before* attempting Redis startup.
            incr = next(
                f for f in inventory["files"]
                if f["name"].endswith(".incr.aof")
            )
            data = restored / "appendonlydir" / incr["name"]
            with data.open("ab") as handle:
                handle.write(b"synthetic-corruption")
            try:
                archive.compare_with_independent_inventory(restored, inventory)
            except ValueError:
                pass
            else:
                raise RuntimeError(REFUSED)

            print("CI_STAGE=tampering_rejected", flush=True)
            # Fresh independent copy (never mount the original synthetic source).
            shutil.rmtree(restored)
            shutil.copytree(source, restored, symlinks=True)
            archive.compare_with_independent_inventory(restored, inventory)
            print("CI_STAGE=second_copy_validated", flush=True)
            start(TARGET, restored)
            print("CI_STAGE=restore_started", flush=True)
            if not data_matches(TARGET):
                raise RuntimeError(REFUSED)
            if docker("exec", TARGET, "redis-cli", "INFO", "persistence").find(
                "loading:1"
            ) >= 0:
                raise RuntimeError(REFUSED)
            print("PASS: verified stopped-source AOF copied to independent offline target")
            print("PASS: tampered archive refused before Redis startup")
            print("PASS: isolated Redis 8.4.8 replay preserved synthetic P1/P2 entries")
            print("LIMIT: CI-only; no live capture, real backup, or production permission")
        finally:
            # Only the two CI-owned disposable container names are targeted.
            docker("rm", "-f", SOURCE, allow_error=True)
            docker("rm", "-f", TARGET, allow_error=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, AssertionError, StopIteration):
        raise SystemExit(REFUSED) from None
