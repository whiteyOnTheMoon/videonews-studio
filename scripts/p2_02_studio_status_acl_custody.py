#!/usr/bin/env python3
"""One-user Studio status Redis ACL custody: fail-closed, no Redis mutation.

--preflight and --verify and --installed are read-only. --prepare creates only
private operator files, and --install-file replaces only the host ACL file.
Neither operation reloads Redis, starts a container or creates a Feed job.
"""
from __future__ import annotations

import argparse
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
OPERATOR_UID = 1000
PRIVATE = SECRETS / "p2-studio-status-redis-acl"
REDIS = "videonews-studio-redis-1"
ACL = "redis_acl"
PASSWORD = "studio-status-redis-password"
CANDIDATE = "redis-acl-with-studio-status"
DIGEST = "redis-acl-original-sha256"
BACKUP = "redis-acl-before-studio-status"
TEMP = ".redis_acl.studio_status_pending"
USERNAME = "vns_feed_status_studio"
BASE_USERS = frozenset({
    "default", "vns_worker", "vns_provider_producer",
    "vns_feed_producer_prod", "vns_feed_consumer_prod",
})
PREPARE_ACK = "CREATE_PRIVATE_STUDIO_STATUS_ACL_CANDIDATE_ONLY"
INSTALL_ACK = "INSTALL_STUDIO_STATUS_ACL_HOST_FILE_ONLY_NO_REDIS_RELOAD"
RESTORE_ACK = "OPERATOR_VERIFIED_OFFHOST_BACKUP_AND_ISOLATED_RESTORE"
REFUSED = "REFUSED: Studio status ACL custody condition failed; inspect before retry"
SHA = re.compile(r"[0-9a-f]{40}\Z")
PASS = re.compile(rb"[A-Za-z0-9_-]{40,128}\n\Z")

def command(argv: list[str]) -> str:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=25, check=False)
    if result.returncode:
        raise RuntimeError(REFUSED)
    return result.stdout.strip()

def operator(expected_sha: str, *, mutation: bool = False) -> None:
    if os.getuid() != OPERATOR_UID or os.geteuid() != OPERATOR_UID or not SHA.fullmatch(expected_sha):
        raise PermissionError(REFUSED)
    git = ["git", "-C", str(ROOT)]
    if (command(git + ["branch", "--show-current"]) != "main"
            or command(git + ["rev-parse", "HEAD"]) != expected_sha
            or command(git + ["status", "--porcelain"])):
        raise RuntimeError(REFUSED)
    if (command(["docker", "inspect", "-f",
                 '{{index .Config.Labels "com.docker.compose.project"}}|'
                 '{{index .Config.Labels "com.docker.compose.service"}}|'
                 '{{.State.Health.Status}}', REDIS])
            != "videonews-studio|redis|healthy"
            or command(["docker", "port", REDIS])):
        raise RuntimeError(REFUSED)
    if mutation:
        remote = command(git + ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]
        if remote != expected_sha:
            raise RuntimeError(REFUSED)

def folder(path: Path) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != OPERATOR_UID or stat.S_IMODE(st.st_mode) != 0o700:
            raise PermissionError(REFUSED)
        return fd
    except BaseException:
        os.close(fd)
        raise

def file_read(fd: int, name: str, mode: int, limit: int = 16384) -> bytes:
    handle = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
    try:
        st = os.fstat(handle)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 1000 or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != mode or not 0 < st.st_size <= limit):
            raise PermissionError(REFUSED)
        raw = os.read(handle, limit + 1)
        if len(raw) != st.st_size:
            raise RuntimeError(REFUSED)
        return raw
    finally:
        os.close(handle)

def absent(fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError(REFUSED)

def parse_original(raw: bytes) -> None:
    if not raw.endswith(b"\n") or len(raw) > 16384:
        raise ValueError(REFUSED)
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise ValueError(REFUSED) from None
    users: dict[str, list[str]] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"user ([A-Za-z0-9_-]+) (.+)", line)
        if not match or match[1] in users:
            raise ValueError(REFUSED)
        users[match[1]] = match[2].split()
    if (set(users) != BASE_USERS or "off" not in users["default"]
            or any("on" not in users[role] for role in BASE_USERS - {"default"})
            or any("~bull:vns:feed:vns-feed-poll:*" not in users[role]
                   for role in ("vns_feed_producer_prod", "vns_feed_consumer_prod"))):
        raise ValueError(REFUSED)

def acl_line(password: bytes) -> bytes:
    if not PASS.fullmatch(password):
        raise ValueError(REFUSED)
    digest = hashlib.sha256(password.rstrip(b"\n")).hexdigest()
    # Two exact sorted sets plus deterministic, per-slot feed job hashes only.
    # No wildcard read access to other BullMQ queues, pub/sub or mutating Lua.
    return (
        f"user {USERNAME} on #{digest} resetkeys "
        "~bull:vns:feed:vns-feed-poll:completed "
        "~bull:vns:feed:vns-feed-poll:failed "
        "~bull:vns:feed:vns-feed-poll:vns-feed-tick-* "
        "resetchannels -@all +zscore +hget +exists +ping +quit\n"
    ).encode("ascii")

def create(fd: int, name: str, data: bytes, mode: int) -> None:
    handle = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                     mode, dir_fd=fd)
    try:
        os.fchmod(handle, mode)
        if os.write(handle, data) != len(data):
            raise OSError(REFUSED)
        os.fsync(handle)
    finally:
        os.close(handle)

def preflight(expected_sha: str) -> None:
    operator(expected_sha)
    parent = folder(SECRETS)
    try:
        parse_original(file_read(parent, ACL, 0o644))
        absent(parent, PRIVATE.name)
        absent(parent, TEMP)
    finally:
        os.close(parent)

def prepare(expected_sha: str) -> None:
    if os.getenv("VNS_P2_STUDIO_STATUS_ACL_PREPARE_APPROVED") != PREPARE_ACK:
        raise PermissionError(REFUSED)
    operator(expected_sha, mutation=True)
    preflight(expected_sha)
    parent = folder(SECRETS)
    try:
        original = file_read(parent, ACL, 0o644)
        parse_original(original)
        absent(parent, PRIVATE.name)
        os.mkdir(PRIVATE.name, mode=0o700, dir_fd=parent)
        private = folder(PRIVATE)
        try:
            password = (secrets.token_urlsafe(48) + "\n").encode("ascii")
            candidate = original + acl_line(password)
            if len(candidate) > 16384:
                raise ValueError(REFUSED)
            create(private, PASSWORD, password, 0o600)
            create(private, CANDIDATE, candidate, 0o600)
            create(private, DIGEST,
                   (hashlib.sha256(original).hexdigest() + "\n").encode("ascii"), 0o600)
            os.fsync(private)
            os.fsync(parent)
        finally:
            os.close(private)
    finally:
        os.close(parent)

def snapshot(private: int, parent: int) -> tuple[bytes, bytes]:
    original = file_read(parent, ACL, 0o644)
    parse_original(original)
    password = file_read(private, PASSWORD, 0o600, 129)
    candidate = file_read(private, CANDIDATE, 0o600)
    digest = file_read(private, DIGEST, 0o600, 65)
    if (candidate != original + acl_line(password)
            or digest != (hashlib.sha256(original).hexdigest() + "\n").encode("ascii")):
        raise RuntimeError(REFUSED)
    absent(private, BACKUP)
    absent(parent, TEMP)
    return original, candidate

def verify(expected_sha: str) -> None:
    operator(expected_sha)
    parent = folder(SECRETS)
    private = folder(PRIVATE)
    try:
        snapshot(private, parent)
    finally:
        os.close(private)
        os.close(parent)

def install_file(expected_sha: str) -> None:
    if (os.getenv("VNS_P2_STUDIO_STATUS_ACL_INSTALL_APPROVED") != INSTALL_ACK
            or os.getenv("VNS_P2_STUDIO_STATUS_ACL_RECOVERY_VERIFIED") != RESTORE_ACK):
        raise PermissionError(REFUSED)
    operator(expected_sha, mutation=True)
    verify(expected_sha)
    parent = folder(SECRETS)
    private = folder(PRIVATE)
    try:
        original, candidate = snapshot(private, parent)
        before = os.stat(ACL, dir_fd=parent, follow_symlinks=False)
        create(private, BACKUP, original, 0o600)
        os.fsync(private)
        create(parent, TEMP, candidate, 0o644)
        os.fsync(parent)
        after = os.stat(ACL, dir_fd=parent, follow_symlinks=False)
        if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise RuntimeError(REFUSED)
        os.replace(TEMP, ACL, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(private)
        os.close(parent)
    installed(expected_sha)

def installed(expected_sha: str) -> None:
    operator(expected_sha)
    parent = folder(SECRETS)
    private = folder(PRIVATE)
    try:
        original = file_read(private, BACKUP, 0o600)
        parse_original(original)
        password = file_read(private, PASSWORD, 0o600, 129)
        candidate = file_read(private, CANDIDATE, 0o600)
        digest = file_read(private, DIGEST, 0o600, 65)
        if (candidate != original + acl_line(password)
                or digest != (hashlib.sha256(original).hexdigest() + "\n").encode("ascii")
                or file_read(parent, ACL, 0o644) != candidate):
            raise RuntimeError(REFUSED)
        absent(parent, TEMP)
    finally:
        os.close(private)
        os.close(parent)

def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="P2 Studio status ACL, file-only custody")
    mode = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "prepare", "verify", "install-file", "installed"):
        mode.add_argument("--" + name, action="store_true")
    parser.add_argument("--expected-sha", required=True)
    opts = parser.parse_args(argv)
    if opts.preflight:
        preflight(opts.expected_sha)
        print("PASS: exact five-user ACL baseline; status user absent; read-only")
    elif opts.prepare:
        prepare(opts.expected_sha)
        print("PASS: one private Studio status credential and ACL candidate prepared; Redis unchanged")
    elif opts.verify:
        verify(opts.expected_sha)
        print("PASS: original ACL intact; private status ACL candidate verified; read-only")
    elif opts.install_file:
        install_file(opts.expected_sha)
        print("PASS: status ACL host file installed; running Redis unchanged, no ACL reload")
    elif opts.installed:
        installed(opts.expected_sha)
        print("PASS: original ACL backup and exact additive status ACL verified; read-only")

if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, PermissionError, UnicodeError,
            subprocess.TimeoutExpired):
        raise SystemExit(REFUSED)
