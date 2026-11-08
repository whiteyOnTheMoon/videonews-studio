#!/usr/bin/env python3
"""Read-only active Redis admission for P2, with no secret in argv/env/logs.

Only the EXISTING Redis container on its private backend is contacted.
AUTH, PING, ACL WHOAMI and forbidden-key GET are the only Redis commands.
No ACL LOAD, queue operation, publication, checkpoint, HTTP or feed start.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
CONTAINER = "videonews-studio-redis-1"
NETWORK = "videonews-studio_backend"
DIR = Path("/var/lib/videonews-studio/p2-feed-runtime-secrets")
ROLES = (
    ("vns_feed_producer_prod", "vns_feed_producer_redis_password"),
    ("vns_feed_consumer_prod", "vns_feed_consumer_redis_password"),
)
FORBIDDEN = "bull:vns:vns-jobs:p2-auth-readonly-deny"
DENIED = "REFUSED: live feed Redis ACL admission not verified; do not start canary"
PASSWORD = re.compile(rb"[A-Za-z0-9_-]{40,128}\n\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")


def run(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=20)
        if result.returncode != 0 or len(result.stdout) > 65536:
            raise RuntimeError(DENIED)
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(DENIED) from None


def verify_release(expected_sha: str) -> None:
    if os.geteuid() != 0 or not SHA.fullmatch(expected_sha):
        raise RuntimeError(DENIED)
    git = ["git", "--no-optional-locks", "-c", "safe.directory=" + str(ROOT), "-C", str(ROOT)]
    if (run(git + ["branch", "--show-current"]) != "main"
            or run(git + ["rev-parse", "HEAD"]) != expected_sha
            or run(git + ["status", "--porcelain"])):
        raise RuntimeError(DENIED)


def active_internal_redis_address() -> str:
    network = json.loads(run(["docker", "network", "inspect", NETWORK]))
    if (not isinstance(network, list) or len(network) != 1
            or network[0].get("Internal") is not True):
        raise RuntimeError(DENIED)
    instances = json.loads(run(["docker", "inspect", CONTAINER]))
    if not isinstance(instances, list) or len(instances) != 1:
        raise RuntimeError(DENIED)
    container = instances[0]
    labels = container.get("Config", {}).get("Labels") or {}
    state = container.get("State") or {}
    endpoints = (container.get("NetworkSettings") or {}).get("Networks") or {}
    published = (container.get("NetworkSettings") or {}).get("Ports") or {}
    if (labels.get("com.docker.compose.project") != "videonews-studio"
            or labels.get("com.docker.compose.service") != "redis"
            or state.get("Running") is not True
            or (state.get("Health") or {}).get("Status") != "healthy"
            or NETWORK not in endpoints
            or any(bindings for bindings in published.values())):
        raise RuntimeError(DENIED)
    address = endpoints[NETWORK].get("IPAddress")
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        raise RuntimeError(DENIED) from None
    if not isinstance(ip, ipaddress.IPv4Address) or not ip.is_private or ip.is_loopback:
        raise RuntimeError(DENIED)
    return str(ip)


def read_password(name: str) -> bytes:
    folder = os.open(DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(folder)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError(DENIED)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        try:
            meta = os.fstat(fd)
            if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1
                    or meta.st_uid != 10002 or meta.st_gid != 10002
                    or stat.S_IMODE(meta.st_mode) != 0o400
                    or not 41 <= meta.st_size <= 129):
                raise RuntimeError(DENIED)
            raw = os.read(fd, 130)
            if len(raw) != meta.st_size or not PASSWORD.fullmatch(raw):
                raise RuntimeError(DENIED)
            return raw[:-1]
        finally:
            os.close(fd)
    finally:
        os.close(folder)


def encode(*args: bytes) -> bytes:
    return (b"*" + str(len(args)).encode("ascii") + b"\r\n" +
            b"".join(b"$" + str(len(v)).encode("ascii") + b"\r\n" +
                     v + b"\r\n" for v in args))


def reply(stream) -> tuple[str, bytes]:
    line = stream.readline(8193)
    if not line.endswith(b"\r\n") or len(line) > 8192:
        raise RuntimeError(DENIED)
    prefix, payload = line[:1], line[1:-2]
    if prefix == b"+":
        return "ok", payload
    if prefix == b"-":
        return "error", payload
    if prefix == b"$":
        if not payload.isdigit() or int(payload) > 8192:
            raise RuntimeError(DENIED)
        n = int(payload)
        body = stream.read(n + 2)
        if len(body) != n + 2 or not body.endswith(b"\r\n"):
            raise RuntimeError(DENIED)
        return "bulk", body[:-2]
    raise RuntimeError(DENIED)


def ask(sock, stream, *args: bytes) -> tuple[str, bytes]:
    sock.sendall(encode(*args))
    return reply(stream)


def verify_identity(ip: str, user: str, password: bytes) -> None:
    with socket.create_connection((ip, 6379), timeout=4) as conn:
        conn.settimeout(4)
        with conn.makefile("rb") as stream:
            if ask(conn, stream, b"AUTH", user.encode("ascii"), password) != ("ok", b"OK"):
                raise RuntimeError(DENIED)
            if ask(conn, stream, b"PING") != ("ok", b"PONG"):
                raise RuntimeError(DENIED)
            if ask(conn, stream, b"ACL", b"WHOAMI") != ("bulk", user.encode("ascii")):
                raise RuntimeError(DENIED)
            result = ask(conn, stream, b"GET", FORBIDDEN.encode("ascii"))
            if result[0] != "error" or not result[1].startswith(b"NOPERM "):
                raise RuntimeError(DENIED)


def verify(expected_sha: str) -> dict[str, object]:
    verify_release(expected_sha)
    ip = active_internal_redis_address()
    passwords = [read_password(filename) for _, filename in ROLES]
    if len(set(passwords)) != len(ROLES):
        raise RuntimeError(DENIED)
    for (user, _), password in zip(ROLES, passwords):
        verify_identity(ip, user, password)
    # Never include the Redis address, password, hashes or raw server responses.
    return {
        "scope": "read_only_active_feed_redis_acl",
        "source": "existing_internal_compose_redis",
        "producer_authenticated": True,
        "consumer_authenticated": True,
        "credentials_distinct": True,
        "p1_queue_key_denied_for_both": True,
        "feed_started": False,
        "checkpoint_changed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only live Redis ACL preflight")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.expected_sha), sort_keys=True))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, UnicodeError,
            subprocess.TimeoutExpired, socket.timeout):
        raise SystemExit(DENIED) from None


if __name__ == "__main__":
    main()
