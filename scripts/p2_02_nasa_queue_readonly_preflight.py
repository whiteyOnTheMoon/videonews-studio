#!/usr/bin/env python3
"""P2-02: inspect the existing isolated BullMQ feed queue without changing it.

Reuses the established root-only, SHA-pinned, protected-secret Redis ACL
admission. Only fixed AUTH/PING/ACL WHOAMI and LLEN/ZCARD/SCARD/EXISTS
commands are sent to Redis; no SCAN, job payloads, raw IDs, SQL or HTTP.
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import time

import p2_02_live_redis_acl_readonly as acl

DENIED = "REFUSED: NASA read-only feed queue inventory unavailable; do not start canary"
PREFIX = b"bull:vns:feed:vns-feed-poll:"
# These are BullMQ data-structure names, not source-derived or caller inputs.
COUNTS = (
    ("waiting", b"LLEN", b"wait"),
    ("active", b"LLEN", b"active"),
    ("paused", b"LLEN", b"paused"),
    ("delayed", b"ZCARD", b"delayed"),
    ("prioritized", b"ZCARD", b"prioritized"),
    ("waiting_children", b"ZCARD", b"waiting-children"),
    ("failed", b"ZCARD", b"failed"),
    ("completed", b"ZCARD", b"completed"),
    ("repeat_schedules", b"ZCARD", b"repeat"),
    ("stalled", b"SCARD", b"stalled"),
)
BLOCKED_SERVICES = frozenset((
    "feed-observer", "feed-scheduler", "feed-producer",
    "feed-producer-continuous", "feed-consumer",
    "feed-project-once", "feed-project-continuous",
    "source-publisher", "source-handoff-import",
))
SERVICE_NAME = re.compile(r"[a-z][a-z0-9-]{1,70}\Z")
STATES = frozenset(("running", "restarting", "paused", "created", "exited", "dead"))
MAX_COUNT = 100000000
SLOT_SECONDS = 15 * 60


def quiescent_services() -> bool:
    # No Docker configuration/secret/log output: fixed compose service/state only.
    output = acl.run([
        "docker", "ps", "-a",
        "--filter", "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}|{{.State}}',
    ])
    if len(output) > 8192:
        raise RuntimeError(DENIED)
    for line in output.splitlines():
        items = line.split("|")
        if (len(items) != 2 or not SERVICE_NAME.fullmatch(items[0])
                or items[1] not in STATES):
            raise RuntimeError(DENIED)
        if items[0] in BLOCKED_SERVICES and items[1] in (
            "running", "restarting", "paused", "created"
        ):
            return False
    return True


def redis_integer(sock, stream, command: bytes, key: bytes) -> int:
    if command not in (b"LLEN", b"ZCARD", b"SCARD", b"EXISTS"):
        raise RuntimeError(DENIED)
    if (not key.startswith(PREFIX) or len(key) > 128
            or not re.fullmatch(rb"[a-z0-9:-]+", key)):
        raise RuntimeError(DENIED)
    sock.sendall(acl.encode(command, key))
    line = stream.readline(64)
    if not re.fullmatch(rb":[0-9]+\r\n", line):
        raise RuntimeError(DENIED)
    value = int(line[1:-2])
    if value > MAX_COUNT or (command == b"EXISTS" and value not in (0, 1)):
        raise RuntimeError(DENIED)
    return value


def inspect_queue(ip: str, password: bytes, slot: int) -> dict[str, object]:
    if not 0 <= slot < 9007199254740991:
        raise RuntimeError(DENIED)
    with socket.create_connection((ip, 6379), timeout=4) as conn:
        conn.settimeout(4)
        with conn.makefile("rb") as stream:
            if acl.ask(conn, stream, b"AUTH", b"vns_feed_consumer_prod", password) != (
                "ok", b"OK"
            ):
                raise RuntimeError(DENIED)
            if acl.ask(conn, stream, b"PING") != ("ok", b"PONG"):
                raise RuntimeError(DENIED)
            if acl.ask(conn, stream, b"ACL", b"WHOAMI") != (
                "bulk", b"vns_feed_consumer_prod"
            ):
                raise RuntimeError(DENIED)
            counts = {
                name: redis_integer(conn, stream, command, PREFIX + suffix)
                for name, command, suffix in COUNTS
            }
            current = redis_integer(
                conn, stream, b"EXISTS",
                PREFIX + ("vns-feed-tick-" + str(slot)).encode("ascii")
            )
            previous = redis_integer(
                conn, stream, b"EXISTS",
                PREFIX + ("vns-feed-tick-" + str(max(0, slot - 1))).encode("ascii")
            )
    return {
        "counts": counts,
        "current_slot_job_present": bool(current),
        "previous_slot_job_present": bool(previous),
    }


def verify(expected_sha: str) -> dict[str, object]:
    acl.verify_release(expected_sha)  # root, pinned clean main
    ip = acl.active_internal_redis_address()  # healthy, private, no published port
    producer = acl.read_password("vns_feed_producer_redis_password")
    consumer = acl.read_password("vns_feed_consumer_redis_password")
    if producer == consumer:
        raise RuntimeError(DENIED)
    # Verify both distinct users and rejection of P1 queue namespace first.
    acl.verify_identity(ip, "vns_feed_producer_prod", producer)
    acl.verify_identity(ip, "vns_feed_consumer_prod", consumer)
    quiet = quiescent_services()
    slot = int(time.time() // SLOT_SECONDS)
    queue = inspect_queue(ip, consumer, slot)
    counts = queue["counts"]
    assert isinstance(counts, dict)
    pending = sum(counts[name] for name in (
        "waiting", "active", "paused", "delayed", "prioritized",
        "waiting_children", "stalled",
    ))
    ready = (
        quiet and pending == 0 and counts["repeat_schedules"] == 0
        and not queue["current_slot_job_present"]
    )
    # Historical completed/failed records (and a previous-slot job)
    # remain visible as bounded counts but are NOT erased or replayed.
    return {
        "scope": "p2_02_nasa_readonly_bullmq_inventory",
        "release": expected_sha,
        "acl_identities_verified": True,
        "distinct_credentials": True,
        "compose_feed_services_quiescent": quiet,
        **queue,
        "status": "reviewable" if ready else "blocked",
        "feed_started": False,
        "jobs_changed": False,
        "checkpoint_changed": False,
        "database_changed": False,
        "production_authorized": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Root-only NASA feed BullMQ queue read-only inventory"
    )
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.expected_sha), sort_keys=True))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError,
            AssertionError, subprocess.TimeoutExpired, socket.timeout):
        raise SystemExit(DENIED) from None


if __name__ == "__main__":
    main()
