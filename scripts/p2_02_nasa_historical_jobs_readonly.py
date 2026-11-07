#!/usr/bin/env python3
"""Bounded redacted, read-only historical BullMQ feed-job review.

Only reads the existing private Redis. No raw IDs, failure strings, payloads,
credentials, IPs, or stored job fields are printed. This is NOT a canary permit.
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess

import p2_02_live_redis_acl_readonly as acl
import p2_02_nasa_queue_readonly_preflight as queue

DENIED = "REFUSED: NASA historical feed jobs could not be reviewed read-only"
MAX_HISTORY_PER_STATE = 20
MAX_REASON_BYTES = 2048
JOB_ID = re.compile(rb"vns-feed-tick-(0|[1-9][0-9]{0,12})\Z")
STATES = (("failed", b"failed"), ("completed", b"completed"))
REASONS = {
    b"Feed queue execution failed": "feed_queue_execution_failed",
    b"Feed queue delivery refused": "feed_queue_delivery_refused",
}


def response_line(stream, limit: int = 64) -> bytes:
    line = stream.readline(limit + 1)
    if len(line) > limit or not line.endswith(b"\r\n"):
        raise RuntimeError(DENIED)
    return line[:-2]


def bulk(stream, limit: int) -> bytes | None:
    line = response_line(stream)
    if line == b"$-1":
        return None
    if not re.fullmatch(rb"\$[0-9]{1,6}", line):
        raise RuntimeError(DENIED)
    length = int(line[1:])
    if length > limit:
        raise RuntimeError(DENIED)
    data = stream.read(length + 2)
    if len(data) != length + 2 or data[-2:] != b"\r\n":
        raise RuntimeError(DENIED)
    return data[:-2]


def historical_ids(sock, stream, state: bytes, count: int) -> list[bytes]:
    if state not in (b"failed", b"completed") or not 0 <= count <= MAX_HISTORY_PER_STATE:
        raise RuntimeError(DENIED)
    if count == 0:
        return []
    sock.sendall(acl.encode(b"ZRANGE", queue.PREFIX + state, b"0", str(count - 1).encode()))
    line = response_line(stream)
    if not re.fullmatch(rb"\*[0-9]{1,2}", line) or int(line[1:]) != count:
        raise RuntimeError(DENIED)
    result = []
    for _ in range(count):
        value = bulk(stream, 64)
        if value is None or not JOB_ID.fullmatch(value):
            raise RuntimeError(DENIED)
        result.append(value)
    if len(set(result)) != count:
        raise RuntimeError(DENIED)
    return result


def job_field(sock, stream, job_id: bytes, field: bytes) -> bytes | None:
    if not JOB_ID.fullmatch(job_id) or field not in (b"name", b"failedReason"):
        raise RuntimeError(DENIED)
    sock.sendall(acl.encode(b"HGET", queue.PREFIX + job_id, field))
    return bulk(stream, MAX_REASON_BYTES if field == b"failedReason" else 32)


def inspect_history(ip: str, password: bytes) -> dict[str, object]:
    # Read capped sets, never job payloads, arbitrary Redis keys or exception text.
    with socket.create_connection((ip, 6379), timeout=4) as conn:
        conn.settimeout(4)
        with conn.makefile("rb") as stream:
            if acl.ask(conn, stream, b"AUTH", b"vns_feed_consumer_prod", password) != ("ok", b"OK"):
                raise RuntimeError(DENIED)
            if acl.ask(conn, stream, b"PING") != ("ok", b"PONG"):
                raise RuntimeError(DENIED)
            if acl.ask(conn, stream, b"ACL", b"WHOAMI") != ("bulk", b"vns_feed_consumer_prod"):
                raise RuntimeError(DENIED)
            counts: dict[str, int] = {}
            ids: dict[str, list[bytes]] = {}
            for state, suffix in STATES:
                count = queue.redis_integer(conn, stream, b"ZCARD", queue.PREFIX + suffix)
                if count > MAX_HISTORY_PER_STATE:
                    raise RuntimeError(DENIED)
                counts[state] = count
                ids[state] = historical_ids(conn, stream, suffix, count)
            if set(ids["failed"]).intersection(ids["completed"]):
                raise RuntimeError(DENIED)
            reasons = {"feed_queue_execution_failed": 0,
                       "feed_queue_delivery_refused": 0,
                       "other_or_missing": 0}
            for state, _ in STATES:
                for job_id in ids[state]:
                    if job_field(conn, stream, job_id, b"name") != b"feed-tick":
                        raise RuntimeError(DENIED)
                    if state == "failed":
                        reason = job_field(conn, stream, job_id, b"failedReason")
                        reasons[REASONS.get(reason, "other_or_missing")] += 1
    return {
        "historical_failed_jobs": counts["failed"],
        "historical_completed_jobs": counts["completed"],
        "failed_reason_classes": reasons,
        "historical_ids_match_contract": True,
        "historical_records_present": True,
        "status": "needs_operator_review" if counts["failed"] else "history_reviewable",
    }


def verify(expected_sha: str) -> dict[str, object]:
    acl.verify_release(expected_sha)
    ip = acl.active_internal_redis_address()
    if not queue.quiescent_services():
        raise RuntimeError(DENIED)
    password = acl.read_password("vns_feed_consumer_redis_password")
    acl.verify_identity(ip, "vns_feed_consumer_prod", password)
    evidence = inspect_history(ip, password)
    return {
        "scope": "p2_02_nasa_historical_feed_jobs_readonly",
        "release": expected_sha,
        "compose_feed_services_quiescent": True,
        **evidence,
        "feed_started": False,
        "jobs_changed": False,
        "database_changed": False,
        "checkpoint_changed": False,
        "production_authorized": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only historical NASA BullMQ feed jobs review")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.expected_sha), sort_keys=True))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError,
            subprocess.TimeoutExpired, socket.timeout):
        raise SystemExit(DENIED) from None


if __name__ == "__main__":
    main()
