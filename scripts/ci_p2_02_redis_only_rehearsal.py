#!/usr/bin/env python3
"""Isolated Redis 8 AOF + ACL inode cutover and rollback rehearsal.

CI-only disposable volume and --network none container. No live VPS target,
database, application service, credential or host port is reachable or used.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

import p2_02_redis_only_maintenance as guard
from p2_02_studio_status_acl_custody import acl_line

if (
    os.environ.get("GITHUB_ACTIONS") != "true"
    or os.environ.get("CI") != "true"
    or os.environ.get("GITHUB_REPOSITORY") != "whiteyOnTheMoon/videonews-studio"
    or os.environ.get("VNS_REDIS_ONLY_MAINTENANCE_CI") != "true"
    or not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))
):
    raise SystemExit("REFUSED: disposable GitHub Actions only")

RUN = os.environ["GITHUB_RUN_ID"]
NAME = "vns-redis-only-rehearsal-" + RUN
VOLUME = "vns-redis-only-aof-" + RUN
PASSWORD = secrets.token_urlsafe(48)
STATUS = secrets.token_urlsafe(48)


def docker(*args: str, stdin: str | None = None, timeout: int = 50,
           allow_error: bool = False) -> str:
    r = subprocess.run(["docker", *args], input=stdin, capture_output=True,
                       text=True, timeout=timeout, check=False)
    if r.returncode and not allow_error:
        raise RuntimeError("Disposable Redis operation failed")
    if len(r.stdout) > 16384 or len(r.stderr) > 16384:
        raise RuntimeError("Oversized synthetic CLI response")
    return r.stdout.strip()


def conversation(user: str, password: str, *commands: str) -> list[str]:
    script = "\n".join([f"AUTH {user} {password}", *commands, "QUIT"]) + "\n"
    result = docker(
        "exec", "-i", NAME, "redis-cli", "--raw", stdin=script
    )
    return [line.strip() for line in result.splitlines() if line.strip()]


def successful(user: str, password: str, *commands: str) -> list[str]:
    lines = conversation(user, password, *commands)
    # redis-cli may omit the QUIT acknowledgement in piped --raw mode.
    if (not lines or lines[0] != "OK"
            or len(lines) not in (len(commands) + 1, len(commands) + 2)
            or (len(lines) == len(commands) + 2 and lines[-1] != "OK")):
        raise RuntimeError("Redis synthetic authentication/command count failed")
    result = lines[1:1 + len(commands)]
    if any("ERR" in line or "NOPERM" in line or "NOAUTH" in line
           for line in result):
        raise RuntimeError("Redis synthetic command failed")
    return result


def start(path: Path) -> None:
    docker(
        "run", "-d", "--rm", "--name", NAME,
        "--network", "none", "--memory", "144m",
        "--memory-swap", "144m", "--cpus", "0.3", "--pids-limit", "64",
        "--mount", f"type=bind,src={path},dst=/run/secrets/redis_acl,readonly",
        "--mount", f"type=volume,src={VOLUME},dst=/data",
        guard.IMAGE,
        "redis-server", "--appendonly", "yes", "--maxmemory", "96mb",
        "--maxmemory-policy", "noeviction", "--aclfile",
        "/run/secrets/redis_acl", "--protected-mode", "yes",
        timeout=180,
    )
    for _ in range(45):
        output = docker("exec", NAME, "redis-cli", "ping", allow_error=True)
        if "NOAUTH" in output:
            return
        time.sleep(1)
    raise RuntimeError("Synthetic Redis container not ready")


def stop() -> None:
    docker("stop", "-t", "15", NAME, timeout=35)


def assert_job_data() -> None:
    p1 = successful("vns_worker", PASSWORD,
                    "ZSCORE bull:vns:vns-jobs:completed p107-ci-probe")
    if p1 != ["12345"]:
        raise RuntimeError("P1 completed probe data lost")
    feed = successful(
        "vns_worker", PASSWORD,
        "ZSCORE bull:vns:feed:vns-feed-poll:completed vns-feed-tick-12345",
        "HGET bull:vns:feed:vns-feed-poll:vns-feed-tick-12345 returnvalue",
    )
    if feed != ["12345", '{"ok":true,"sourcesExamined":1,"candidatesAdded":2,"notModified":0}']:
        raise RuntimeError("P2 completed feed data lost")


def role_is_absent() -> None:
    lines = conversation("vns_feed_status_studio", STATUS, "PING")
    if not lines or not lines[0].startswith("WRONGPASS"):
        # ioredis RESP errors include a leading ERR or WRONGPASS, whereas
        # redis-cli --raw reports WRONGPASS without exposing secrets.
        if not lines or "WRONGPASS" not in lines[0]:
            raise RuntimeError("Inactive role unexpectedly authenticated")


def role_is_restricted() -> None:
    lines = conversation(
        "vns_feed_status_studio", STATUS,
        "PING",
        "ZSCORE bull:vns:feed:vns-feed-poll:completed vns-feed-tick-12345",
        "HGET bull:vns:feed:vns-feed-poll:vns-feed-tick-12345 returnvalue",
        "EXISTS bull:vns:feed:vns-feed-poll:vns-feed-tick-12345",
        "GET bull:vns:vns-jobs:outside-denied",
    )
    if not (
        len(lines) in (6, 7)
        and lines[0:3] == ["OK", "PONG", "12345"]
        and lines[3] == '{"ok":true,"sourcesExamined":1,"candidatesAdded":2,"notModified":0}'
        and lines[4] == "1"
        and "NOPERM" in lines[5]
    ):
        raise RuntimeError("Status read-only ACL scope mismatch")


def hashed(username: str, scope: str) -> str:
    password_hash = hashlib.sha256(PASSWORD.encode("ascii")).hexdigest()
    return f"user {username} on #{password_hash} {scope}\n"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="vns-redis-only-") as temp:
        root = Path(temp)
        acl = root / "redis_acl"
        candidate = root / "candidate"
        backup = root / "rollback-backup"
        baseline = (
            "user default off\n"
            + hashed("vns_worker", "~bull:vns:* +@all -@admin -@dangerous +info")
            + hashed("vns_provider_producer",
                     "~bull:vns:vns-provider-text:* +@all -@dangerous +info")
            + hashed("vns_feed_producer_prod",
                     "~bull:vns:feed:vns-feed-poll:* +@all -@admin -@dangerous +info")
            + hashed("vns_feed_consumer_prod",
                     "~bull:vns:feed:vns-feed-poll:* +@all -@admin -@dangerous +info")
        ).encode("ascii")
        acl.write_bytes(baseline)
        acl.chmod(0o644)
        backup.write_bytes(baseline)
        backup.chmod(0o600)
        docker("volume", "create", "--name", VOLUME)
        try:
            start(acl)
            role_is_absent()
            lines = successful(
                "vns_worker", PASSWORD,
                "ZADD bull:vns:vns-jobs:completed 12345 p107-ci-probe",
                "ZADD bull:vns:feed:vns-feed-poll:completed 12345 vns-feed-tick-12345",
                "HSET bull:vns:feed:vns-feed-poll:vns-feed-tick-12345 returnvalue '{\"ok\":true,\"sourcesExamined\":1,\"candidatesAdded\":2,\"notModified\":0}'",
            )
            if lines != ["1", "1", "1"]:
                classes = [v if v in {"0", "1", "2"} else "OTHER" for v in lines]
                raise RuntimeError(f"Synthetic baseline write result classes: {classes}")
            assert_job_data()

            candidate.write_bytes(baseline + acl_line((STATUS + "\n").encode("ascii")))
            candidate.chmod(0o644)
            os.replace(candidate, acl)
            old_inode = docker(
                "exec", NAME, "stat", "-Lc", "%d:%i", "/run/secrets/redis_acl"
            )
            host_inode = f"{acl.stat().st_dev}:{acl.stat().st_ino}"
            if old_inode == host_inode:
                raise RuntimeError("Synthetic ACL bind did not retain original inode")
            role_is_absent()
            assert_job_data()
            stop()

            # Fresh bind picks up the additive role; AOF restores P1/P2 data.
            start(acl)
            role_is_restricted()
            assert_job_data()
            stop()

            # Failed deployment: deliberately invalid ACL file refuses startup.
            bad = root / "invalid-acl"
            bad.write_bytes(acl.read_bytes() + b"invalid-redis-acl-command\n")
            bad.chmod(0o644)
            os.replace(bad, acl)
            docker(
                "run", "-d", "--rm", "--name", NAME, "--network", "none",
                "--memory", "144m", "--memory-swap", "144m",
                "--mount", f"type=bind,src={acl},dst=/run/secrets/redis_acl,readonly",
                "--mount", f"type=volume,src={VOLUME},dst=/data",
                guard.IMAGE, "redis-server", "--appendonly", "yes",
                "--aclfile", "/run/secrets/redis_acl",
                timeout=180,
            )
            for _ in range(30):
                exists = docker("ps", "--filter", f"name=^{NAME}$",
                                "--format", "{{.Names}}")
                if not exists:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Invalid ACL unexpectedly allowed Redis to run")

            # Offline, explicit rollback restores only original ACL bytes and
            # starts the same Redis 8 image on the same retained AOF volume.
            recovered = root / "restore"
            recovered.write_bytes(backup.read_bytes())
            recovered.chmod(0o644)
            os.replace(recovered, acl)
            if acl.read_bytes() != baseline:
                raise RuntimeError("ACL rollback changed original identities")
            start(acl)
            role_is_absent()
            assert_job_data()
            print("PASS: old ACL bind inode stays stale until Redis-only recreation")
            print("PASS: new status ACL works and P1/P2 data survive Redis 8 AOF restart")
            print("PASS: injected bad ACL start refused; original ACL restored on same AOF")
        finally:
            docker("rm", "-f", NAME, allow_error=True)
            docker("volume", "rm", VOLUME, allow_error=True)


if __name__ == "__main__":
    main()
