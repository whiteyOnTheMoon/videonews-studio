#!/usr/bin/env python3
"""P2-02: add two feed-only Redis ACL users without altering running Redis.

No ACL LOAD, restart, Docker Compose changes, publication or network feed.
Stage only creates operator-private passwords. Install changes a HOST file
after a separately SHA-pinned operator acknowledgement; the active Redis
container remains unchanged until a distinct approved recreation.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / "secrets"
PRIVATE = SECRETS / "p2-feed-redis-acl"
ACL_FILE = "redis_acl"
MERGED = "redis-acl-with-feed"
BASELINE = "redis-acl-baseline-sha256"
BACKUP = "redis-acl-before-feed"
TEMP = ".redis_acl.p2_feed_pending"
REDIS = "videonews-studio-redis-1"
PIN = "VNS_P2_FEED_REDIS_ACL_EXPECTED_SHA"
APPROVAL = "VNS_P2_FEED_REDIS_ACL_INSTALL_APPROVED"
APPROVAL_VALUE = "INSTALL_TWO_FEED_ACL_USERS_FILE_ONLY"
FAIL = "REFUSED: P2 feed Redis ACL custody condition failed; inspect before retry"
SHA = re.compile(r"[0-9a-f]{40}")
PW = re.compile(rb"[A-Za-z0-9_-]{40,128}\n")
USERS = (
    ("vns_feed_producer_prod", "feed-producer-redis-password"),
    ("vns_feed_consumer_prod", "feed-consumer-redis-password"),
)
SCOPE = "bull:vns:feed:vns-feed-poll:*"


def command(argv: list[str], *, timeout: int = 25) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=timeout, check=False
    )
    # Do not reveal Docker or Git output on errors.
    if result.returncode:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def operator(expected_sha: str, *, approval: bool = False) -> None:
    if os.geteuid() != 1000 or not SHA.fullmatch(expected_sha):
        raise PermissionError(FAIL)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]) != expected_sha:
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    if command([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        REDIS,
    ]) != "videonews-studio|redis|healthy":
        raise RuntimeError(FAIL)
    if command(["docker", "port", REDIS]):
        raise RuntimeError(FAIL)
    if approval:
        if (os.getenv(APPROVAL) != APPROVAL_VALUE
                or os.getenv(PIN) != expected_sha
                or command([
                    "git", "-C", str(ROOT), "ls-remote",
                    "origin", "refs/heads/main"
                ]).split("\t")[0] != expected_sha):
            raise PermissionError(FAIL)


def private_directory(path: Path, expected_uid: int = 1000) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (info.st_uid != expected_uid
                or not stat.S_ISDIR(info.st_mode)
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise PermissionError(FAIL)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_regular(fd: int, name: str, mode: int, maximum: int = 16384) -> bytes:
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        st = os.fstat(handle)
        if (not stat.S_ISREG(st.st_mode)
                or st.st_uid != os.geteuid() or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != mode
                or not 0 < st.st_size <= maximum):
            raise PermissionError(FAIL)
        data = os.read(handle, maximum + 1)
        if len(data) != st.st_size:
            raise RuntimeError(FAIL)
        return data
    finally:
        os.close(handle)


def missing(fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError(FAIL)


def acl_users(original: bytes) -> None:
    """Validate only known protected identities and no pre-existing feed roles."""
    if not original.endswith(b"\n") or len(original) > 16384:
        raise ValueError(FAIL)
    try:
        lines = original.decode("ascii").splitlines()
    except UnicodeError:
        raise ValueError(FAIL) from None
    users: dict[str, list[str]] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"user ([A-Za-z0-9_-]+) (.+)", line)
        if not match or match[1] in users:
            raise ValueError(FAIL)
        users[match[1]] = match[2].split()
    if (set(users) != {"default", "vns_worker", "vns_provider_producer"}
            or "off" not in users["default"]
            or "on" not in users["vns_worker"]
            or "on" not in users["vns_provider_producer"]):
        raise ValueError(FAIL)


def acl_line(name: str, password: str) -> bytes:
    if name not in [item[0] for item in USERS] or not re.fullmatch(
        r"[A-Za-z0-9_-]{40,128}", password
    ):
        raise ValueError(FAIL)
    digest = hashlib.sha256(password.encode("ascii")).hexdigest()
    # Exact BullMQ prefix. No probe, research or provider keyspace.
    # The consumer must execute the usual BullMQ Lua scripts.
    return (
        f"user {name} on #{digest} resetkeys ~{SCOPE} "
        f"resetchannels &{SCOPE} +@all -@admin -@dangerous "
        "+info +acl|whoami\n"
    ).encode("ascii")


def credentials(fd: int) -> tuple[str, str]:
    passwords = []
    for _, name in USERS:
        data = read_regular(fd, name, 0o600, 129)
        if not PW.fullmatch(data):
            raise ValueError(FAIL)
        passwords.append(data[:-1].decode("ascii"))
    if passwords[0] == passwords[1]:
        raise ValueError(FAIL)
    return passwords[0], passwords[1]


def desired(original: bytes, passwords: tuple[str, str]) -> bytes:
    acl_users(original)
    result = original + b"".join(
        acl_line(name, password) for (name, _), password in zip(USERS, passwords)
    )
    if len(result) > 16384:
        raise ValueError(FAIL)
    return result


def create(fd: int, name: str, data: bytes, mode: int) -> None:
    handle = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode, dir_fd=fd
    )
    try:
        if os.write(handle, data) != len(data):
            raise OSError(FAIL)
        # Resist operator's umask 077; Redis ACL host file must be 0644.
        os.fchmod(handle, mode)
        os.fsync(handle)
    finally:
        os.close(handle)


def stage(expected_sha: str) -> None:
    operator(expected_sha)
    secrets_fd = private_directory(SECRETS)
    try:
        acl_users(read_regular(secrets_fd, ACL_FILE, 0o644))
        missing(secrets_fd, TEMP)
        os.mkdir(PRIVATE.name, 0o700, dir_fd=secrets_fd)
    finally:
        os.close(secrets_fd)
    fd = private_directory(PRIVATE)
    try:
        passwords = [secrets.token_urlsafe(48) for _ in USERS]
        if passwords[0] == passwords[1]:
            raise RuntimeError(FAIL)
        for (_, name), pw in zip(USERS, passwords):
            if not PW.fullmatch((pw + "\n").encode("ascii")):
                raise RuntimeError(FAIL)
            create(fd, name, (pw + "\n").encode("ascii"), 0o600)
        os.fsync(fd)
    finally:
        os.close(fd)


def preflight(expected_sha: str) -> None:
    operator(expected_sha)
    private = private_directory(PRIVATE)
    secrets_fd = private_directory(SECRETS)
    try:
        original = read_regular(secrets_fd, ACL_FILE, 0o644)
        desired(original, credentials(private))
        for name in (MERGED, BASELINE, BACKUP):
            missing(private, name)
        missing(secrets_fd, TEMP)
    finally:
        os.close(secrets_fd)
        os.close(private)


def prepare(expected_sha: str) -> None:
    preflight(expected_sha)
    private = private_directory(PRIVATE)
    secrets_fd = private_directory(SECRETS)
    created = []
    try:
        original = read_regular(secrets_fd, ACL_FILE, 0o644)
        merged = desired(original, credentials(private))
        for name, data in (
            (MERGED, merged),
            (BASELINE, hashlib.sha256(original).hexdigest().encode("ascii") + b"\n"),
        ):
            create(private, name, data, 0o600)
            created.append(name)
        os.fsync(private)
    except BaseException:
        for name in created:
            os.unlink(name, dir_fd=private)
        raise
    finally:
        os.close(secrets_fd)
        os.close(private)


def verified_snapshot(private: int, secrets_fd: int) -> tuple[bytes, bytes]:
    original = read_regular(secrets_fd, ACL_FILE, 0o644)
    expected = desired(original, credentials(private))
    merged = read_regular(private, MERGED, 0o600)
    digest = read_regular(private, BASELINE, 0o600, 65)
    if (merged != expected
            or digest != hashlib.sha256(original).hexdigest().encode("ascii") + b"\n"):
        raise RuntimeError(FAIL)
    missing(private, BACKUP)
    missing(secrets_fd, TEMP)
    return original, merged


def verify(expected_sha: str) -> None:
    operator(expected_sha)
    private = private_directory(PRIVATE)
    secrets_fd = private_directory(SECRETS)
    try:
        verified_snapshot(private, secrets_fd)
    finally:
        os.close(secrets_fd)
        os.close(private)


def installed(expected_sha: str) -> None:
    operator(expected_sha)
    private = private_directory(PRIVATE)
    secrets_fd = private_directory(SECRETS)
    try:
        old = read_regular(private, BACKUP, 0o600)
        original_hash = read_regular(private, BASELINE, 0o600, 65)
        candidate = read_regular(private, MERGED, 0o600)
        actual = read_regular(secrets_fd, ACL_FILE, 0o644)
        if (original_hash != hashlib.sha256(old).hexdigest().encode("ascii") + b"\n"
                or candidate != desired(old, credentials(private))
                or actual != candidate):
            raise RuntimeError(FAIL)
        missing(secrets_fd, TEMP)
    finally:
        os.close(secrets_fd)
        os.close(private)


def install_file(expected_sha: str) -> None:
    operator(expected_sha, approval=True)
    verify(expected_sha)
    private = private_directory(PRIVATE)
    secrets_fd = private_directory(SECRETS)
    try:
        original, candidate = verified_snapshot(private, secrets_fd)
        before = os.stat(ACL_FILE, dir_fd=secrets_fd, follow_symlinks=False)
        create(private, BACKUP, original, 0o600)
        os.fsync(private)
        create(secrets_fd, TEMP, candidate, 0o644)
        os.fsync(secrets_fd)
        current = os.stat(ACL_FILE, dir_fd=secrets_fd, follow_symlinks=False)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns
        ):
            raise RuntimeError(FAIL)
        os.replace(TEMP, ACL_FILE, src_dir_fd=secrets_fd, dst_dir_fd=secrets_fd)
        os.fsync(secrets_fd)
    finally:
        os.close(secrets_fd)
        os.close(private)
    installed(expected_sha)


def main(args: list[str]) -> None:
    import argparse
    parser = argparse.ArgumentParser(description="P2 feed-only additive Redis ACL custody")
    group = parser.add_mutually_exclusive_group(required=True)
    for option in ("stage", "preflight", "prepare", "verify", "install-file", "installed"):
        group.add_argument("--" + option, action="store_true")
    parser.add_argument("--expected-sha", required=True)
    opts = parser.parse_args(args)
    if opts.stage:
        stage(opts.expected_sha)
        print("PASS: two separate private feed Redis credentials staged; ACL unchanged")
    elif opts.preflight:
        preflight(opts.expected_sha)
        print("PASS: existing Redis users preserved; private feed credentials verified")
    elif opts.prepare:
        prepare(opts.expected_sha)
        print("PASS: private two-user additive ACL candidate prepared; live Redis unchanged")
    elif opts.verify:
        verify(opts.expected_sha)
        print("PASS: original Redis ACL unchanged; exact private feed ACL candidate verified")
    elif opts.install_file:
        install_file(opts.expected_sha)
        print("PASS: additive feed ACL host file installed; running Redis unchanged")
    elif opts.installed:
        installed(opts.expected_sha)
        print("PASS: existing Redis users preserved and two feed users present on disk")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError,
            UnicodeError, subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
