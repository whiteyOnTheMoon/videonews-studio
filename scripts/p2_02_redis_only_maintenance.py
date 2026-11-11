#!/usr/bin/env python3
"""Strictly read-only Redis-only cutover operator: preflight and postcheck.

There is deliberately NO --execute, --rollback, --recreate, ACL LOAD or writes.
Only a separately reviewed and approved future maintenance procedure may act.
"""
from __future__ import annotations

import argparse
import importlib.util
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
VOLUME = "videonews-studio_redis_p109_restored"
LEGACY_VOLUME = "videonews-studio_redis_data"
IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
FILES = (
    "compose.yaml",
    "deploy/compose.worker.yaml",
    "deploy/compose.redis84-production.yaml",
)
BLOCKED_SERVICES = {
    "feed-observer", "feed-scheduler", "feed-producer",
    "feed-producer-continuous", "feed-consumer", "feed-project-once",
    "feed-project-continuous", "source-publisher", "source-handoff-import",
}
ACTIVE_STATES = {"running", "restarting", "paused", "created"}
SHA = re.compile(r"[0-9a-f]{40}\Z")
PASSWORD = re.compile(rb"[A-Za-z0-9_-]{40,128}\n\Z")
REFUSED = "REFUSED: Redis-only maintenance inspection incomplete; no changes made"


def command(args: list[str], *, limit: int = 1024 * 1024) -> str:
    result = subprocess.run(args, capture_output=True, text=True,
                            timeout=30, check=False)
    if result.returncode or len(result.stdout) > limit:
        raise RuntimeError(REFUSED)
    return result.stdout.strip()


def require_checkout(expected_sha: str) -> None:
    if (os.getuid() != 1000 or os.geteuid() != 1000 or
            not SHA.fullmatch(expected_sha)):
        raise PermissionError(REFUSED)
    git = ["git", "--no-optional-locks", "-C", str(ROOT)]
    if (command(git + ["branch", "--show-current"]) != "main"
            or command(git + ["rev-parse", "HEAD"]) != expected_sha
            or command(git + ["status", "--porcelain"])):
        raise RuntimeError(REFUSED)


def render(files: tuple[str, ...]) -> dict:
    args = ["docker", "compose", "--profile", "data", "--profile", "worker"]
    for file in files:
        args.extend(["-f", file])
    args += ["config", "--format", "json"]
    return json.loads(command(args))


def require_compose() -> dict:
    """Reuse the existing reviewed Redis-8.4.8 guard, with both profiles."""
    base, prod = render(FILES[:2]), render(FILES)
    spec = importlib.util.spec_from_file_location(
        "redis84_guard", ROOT / "scripts/check_redis84_production_compose.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(REFUSED)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    if guard.verify(base, prod) is not True:
        raise RuntimeError(REFUSED)
    if prod.get("name") != "videonews-studio":
        raise RuntimeError(REFUSED)
    return prod["services"]["redis"]


def require_installed_acl(expected_sha: str) -> None:
    import p2_02_studio_status_acl_custody as custody
    custody.installed(expected_sha)


def inspect() -> dict:
    instances = json.loads(command(["docker", "inspect", CONTAINER]))
    if not isinstance(instances, list) or len(instances) != 1:
        raise RuntimeError(REFUSED)
    return instances[0]


def inode_from_container() -> tuple[int, int]:
    result = command([
        "docker", "exec", CONTAINER,
        "stat", "-Lc", "%d:%i", "/run/secrets/redis_acl",
    ], limit=80)
    if not re.fullmatch(r"[0-9]+:[0-9]+", result):
        raise RuntimeError(REFUSED)
    return tuple(int(i) for i in result.split(":"))


def read_private_status_password() -> bytes:
    import p2_02_studio_status_acl_custody as custody
    fd = custody.folder(custody.PRIVATE)
    try:
        raw = custody.file_read(fd, custody.PASSWORD, 0o600, 129)
        if not PASSWORD.fullmatch(raw):
            raise RuntimeError(REFUSED)
        return raw[:-1]
    finally:
        os.close(fd)


def check_service_quiescence() -> None:
    raw = command([
        "docker", "ps", "-a",
        "--filter", "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}|{{.State}}',
    ], limit=8192)
    for line in raw.splitlines():
        if not re.fullmatch(r"[a-z0-9-]{2,70}\|[a-z]+", line):
            raise RuntimeError(REFUSED)
        service, state = line.split("|", 1)
        if service in BLOCKED_SERVICES and state in ACTIVE_STATES:
            raise RuntimeError(REFUSED)


def redis_assessment(
    definition: dict, live: dict, image_id: str,
    acl_inode: tuple[int, int], host_inode: tuple[int, int],
    free_bytes: int,
) -> dict:
    labels = live.get("Config", {}).get("Labels") or {}
    health = live.get("State", {}).get("Health") or {}
    mounts = live.get("Mounts") or []
    acl = [m for m in mounts if m.get("Destination") == "/run/secrets/redis_acl"]
    data = [m for m in mounts if m.get("Destination") == "/data"]
    networks = (live.get("NetworkSettings") or {}).get("Networks") or {}
    ports = (live.get("NetworkSettings") or {}).get("Ports") or {}
    config = live.get("Config") or {}

    if (labels.get("com.docker.compose.project") != "videonews-studio"
            or labels.get("com.docker.compose.service") != "redis"
            or live.get("State", {}).get("Running") is not True
            or health.get("Status") != "healthy"
            or live.get("RestartCount") != 0
            or config.get("Image") != IMAGE
            or config.get("Image") != definition.get("image")
            or live.get("Image") != image_id
            or config.get("Cmd") != definition.get("command")
            or set(networks) != {NETWORK}
            or any(v for v in ports.values())
            or len(acl) != 1
            or acl[0].get("Type") != "bind"
            or acl[0].get("RW") is not False
            or len(data) != 1
            or data[0].get("Type") != "volume"
            or data[0].get("Name") != VOLUME
            or free_bytes < 8 * 1024 ** 3):
        raise RuntimeError(REFUSED)

    source = Path(acl[0]["Source"])
    if source.resolve(strict=True) != (ROOT / "secrets/redis_acl").resolve(strict=True):
        raise RuntimeError(REFUSED)
    return {
        "redis8_digest_and_image_id_verified": True,
        "restored_aof_volume_preserved": True,
        "redis_healthy": True,
        "redis_private_network_only": True,
        "acl_secret_bind_read_only": True,
        "acl_mount_current_inode": acl_inode == host_inode,
        "disk_free_at_least_8_gib": True,
        "read_only": True,
    }


def check_status_auth(ip: str, password: bytes) -> None:
    import p2_02_live_redis_acl_readonly as protocol
    with socket.create_connection((ip, 6379), timeout=4) as conn:
        conn.settimeout(4)
        with conn.makefile("rb") as stream:
            if protocol.ask(conn, stream, b"AUTH",
                            b"vns_feed_status_studio", password) != ("ok", b"OK"):
                raise RuntimeError(REFUSED)
            if protocol.ask(conn, stream, b"PING") != ("ok", b"PONG"):
                raise RuntimeError(REFUSED)
            denial = protocol.ask(
                conn, stream, b"GET", b"bull:vns:vns-jobs:read-only-deny"
            )
            if denial[0] != "error" or not denial[1].startswith(b"NOPERM "):
                raise RuntimeError(REFUSED)


def verify(expected_sha: str, *, postcheck: bool = False) -> dict:
    require_checkout(expected_sha)
    require_installed_acl(expected_sha)
    definition = require_compose()
    live = inspect()
    check_service_quiescence()
    net = json.loads(command(["docker", "network", "inspect", NETWORK]))
    if not isinstance(net, list) or len(net) != 1 or net[0].get("Internal") is not True:
        raise RuntimeError(REFUSED)
    volumes = set(command([
        "docker", "volume", "ls", "--format", "{{.Name}}"
    ], limit=65536).splitlines())
    if not {VOLUME, LEGACY_VOLUME}.issubset(volumes):
        raise RuntimeError(REFUSED)
    image_id = command(["docker", "image", "inspect", "-f", "{{.Id}}", IMAGE], limit=256)
    inode = inode_from_container()
    st = os.stat(ROOT / "secrets/redis_acl", follow_symlinks=False)
    if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1
            or stat.S_IMODE(st.st_mode) != 0o644 or st.st_uid != os.getuid()):
        raise RuntimeError(REFUSED)
    disk = os.statvfs("/var/lib/docker")
    result = redis_assessment(
        definition, live, image_id, inode, (st.st_dev, st.st_ino),
        disk.f_bavail * disk.f_frsize,
    )
    mounted_current = result["acl_mount_current_inode"]
    if mounted_current != postcheck:
        raise RuntimeError(REFUSED)
    if postcheck:
        endpoint = (live.get("NetworkSettings") or {}).get("Networks", {}).get(NETWORK, {})
        ip = endpoint.get("IPAddress")
        try:
            address = ipaddress.ip_address(ip)
        except ValueError:
            raise RuntimeError(REFUSED) from None
        if (not isinstance(address, ipaddress.IPv4Address)
                or not address.is_private or address.is_loopback
                or address.is_link_local):
            raise RuntimeError(REFUSED)
        check_status_auth(ip, read_private_status_password())
        result["studio_status_auth_and_foreign_key_denial"] = True
    result["mode"] = "postcheck" if postcheck else "preflight"
    result["p1_p2_queue_reaudit_required"] = True
    result["recovery_proof_requires_independent_review"] = True
    result["maintenance_execution_authorized"] = False
    return result


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Redis-only non-mutating maintenance guard")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--postcheck", action="store_true")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args(argv)
    result = verify(args.expected_sha, postcheck=args.postcheck)
    print(json.dumps(result, sort_keys=True))
    print("PASS: Redis-only inspection; no changes made")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, PermissionError, ValueError, KeyError,
            TypeError, AssertionError, UnicodeError, subprocess.TimeoutExpired,
            socket.timeout):
        raise SystemExit(REFUSED) from None
