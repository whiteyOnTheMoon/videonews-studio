#!/usr/bin/env python3
"""P2-02: explicitly approved root-owned runtime copies for five existing secrets.

No password rotation, rootless bypass, Docker, network, GitHub modification,
PostgreSQL/Redis action, or process activation. Always preserve source secrets.
Root install is a ONE-SHOT operation; partial results must be inspected, not retried.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCES = (
    ("secrets/p2-feed-login-custody/vns_source_export_db_password",
     "vns_source_export_db_password", 10001),
    ("secrets/p2-feed-login-custody/vns_feed_db_password",
     "vns_feed_db_password", 10002),
    ("secrets/p2-feed-redis-acl/feed-producer-redis-password",
     "vns_feed_producer_redis_password", 10002),
    ("secrets/p2-feed-redis-acl/feed-consumer-redis-password",
     "vns_feed_consumer_redis_password", 10002),
    ("secrets/p2-feed-login-custody/vns_feed_project_db_password",
     "vns_feed_project_db_password", 10004),
)
DEST_PARENT = Path("/var/lib/videonews-studio")
DEST_DIR = DEST_PARENT / "p2-feed-runtime-secrets"
EXPECTED_RELEASE_PATTERN = re.compile(r"[a-f0-9]{40}\Z")
PASSWORD_PATTERN = re.compile(rb"[A-Za-z0-9_-]{40,128}\n\Z")
INSTALL_APPROVAL = "INSTALL_FIVE_RESTRICTED_FEED_SECRET_COPIES_ONLY"
DENIED = "REFUSED: P2 feed secret handoff unsafe; inspect state before any retry"


def command(argv: list[str]) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=30, check=False
    )
    if result.returncode:
        raise RuntimeError(DENIED)
    return result.stdout.strip()


def check_release(expected_sha: str, *, install: bool = False) -> None:
    if (not EXPECTED_RELEASE_PATTERN.fullmatch(expected_sha)
            or os.geteuid() != (0 if install else 1000)):
        raise PermissionError(DENIED)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(DENIED)
    if command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]) != expected_sha:
        raise RuntimeError(DENIED)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(DENIED)
    if install:
        remote = command([
            "git", "-C", str(ROOT), "ls-remote", "origin", "refs/heads/main"
        ]).split("\t")[0]
        if remote != expected_sha:
            raise RuntimeError(DENIED)


def open_folder(path: Path, owner: int, mode: int) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if (not stat.S_ISDIR(meta.st_mode)
                or meta.st_uid != owner
                or stat.S_IMODE(meta.st_mode) != mode):
            raise PermissionError(DENIED)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_private(fd: int, name: str, owner: int, mode: int) -> bytes:
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        meta = os.fstat(handle)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != owner
                or meta.st_gid < 0 or meta.st_nlink != 1
                or stat.S_IMODE(meta.st_mode) != mode
                or not 41 <= meta.st_size <= 129):
            raise PermissionError(DENIED)
        data = os.read(handle, 130)
        if len(data) != meta.st_size or not PASSWORD_PATTERN.fullmatch(data):
            raise ValueError(DENIED)
        return data
    finally:
        os.close(handle)


def original_passwords() -> tuple[bytes, ...]:
    # Always require the exact two pre-existing private directories and five
    # independently generated passwords; never regenerate them.
    values: list[bytes] = []
    for source, _, _ in SOURCES:
        path = ROOT / source
        fd = open_folder(path.parent, 1000, 0o700)
        try:
            values.append(read_private(fd, path.name, 1000, 0o600))
        finally:
            os.close(fd)
    if len(set(values)) != len(SOURCES):
        raise ValueError(DENIED)
    return tuple(values)


def require_missing(parent_fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError(DENIED)


def secure_parent() -> int:
    # /var/lib is an existing root-owned administrative directory and must
    # not be writable by other principals before any new files are installed.
    parent = os.open("/var/lib", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(parent)
        if (info.st_uid != 0 or not stat.S_ISDIR(info.st_mode)
                or (stat.S_IMODE(info.st_mode) & 0o022)):
            raise PermissionError(DENIED)
        return parent
    except BaseException:
        os.close(parent)
        raise


def create_secret(fd: int, name: str, data: bytes, uid: int) -> None:
    handle = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400, dir_fd=fd,
    )
    try:
        os.fchown(handle, uid, uid)
        os.fchmod(handle, 0o400)
        if os.write(handle, data) != len(data):
            raise OSError(DENIED)
        os.fsync(handle)
    finally:
        os.close(handle)


def check_container_absence() -> None:
    """No runtime service may already be holding an older secret bind mount."""
    result = command([
        "docker", "ps", "-a", "--filter",
        "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}',
    ]).splitlines()
    blocked = {
        "source-publisher", "feed-producer", "feed-producer-continuous",
        "feed-consumer", "feed-project-once", "feed-project-continuous",
        "feed-observer", "feed-scheduler",
    }
    if blocked.intersection(result):
        raise RuntimeError(DENIED)


def preflight(expected_sha: str) -> None:
    check_release(expected_sha)
    original_passwords()
    check_container_absence()
    # A user cannot necessarily stat the root-owned destination if it already
    # exists. This *non-root* check makes no claim about target absence.
    print("PASS: five separate source passwords and absent feed containers verified")
    print("Root-owned runtime target existence is checked again during installation")


def verify_destinations() -> None:
    if os.geteuid() != 0:
        raise PermissionError(DENIED)
    original = original_passwords()
    parent = secure_parent()
    try:
        base = open_folder(DEST_PARENT, 0, 0o700)
        try:
            dest = open_folder(DEST_DIR, 0, 0o700)
            try:
                listing = os.listdir(dest)
                if set(listing) != {target for _, target, _ in SOURCES}:
                    raise RuntimeError(DENIED)
                for (_, name, uid), data in zip(SOURCES, original):
                    if read_private(dest, name, uid, 0o400) != data:
                        raise RuntimeError(DENIED)
            finally:
                os.close(dest)
        finally:
            os.close(base)
    finally:
        os.close(parent)


def install(expected_sha: str, approval: str) -> None:
    if approval != INSTALL_APPROVAL:
        raise PermissionError(DENIED)
    check_release(expected_sha, install=True)
    values = original_passwords()
    check_container_absence()
    lib = secure_parent()
    try:
        # Existing base can be shared with other P2 secrets only if already
        # root-owned and 0700; avoid modifying existing ownership or modes.
        try:
            os.mkdir(DEST_PARENT.name, 0o700, dir_fd=lib)
            os.fsync(lib)
        except FileExistsError:
            pass
        base = open_folder(DEST_PARENT, 0, 0o700)
        try:
            require_missing(base, DEST_DIR.name)
            os.mkdir(DEST_DIR.name, 0o700, dir_fd=base)
            dest = open_folder(DEST_DIR, 0, 0o700)
            try:
                for (_, name, uid), value in zip(SOURCES, values):
                    create_secret(dest, name, value, uid)
                os.fsync(dest)
                os.fsync(base)
            finally:
                os.close(dest)
        finally:
            os.close(base)
    finally:
        os.close(lib)
    verify_destinations()


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="P2-02 five-secret UID handoff")
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "install", "verify"):
        action.add_argument("--" + name, action="store_true")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--approval", default="")
    args = parser.parse_args(argv)
    if args.preflight:
        if args.approval:
            raise ValueError(DENIED)
        preflight(args.expected_sha)
    elif args.install:
        install(args.expected_sha, args.approval)
        print("PASS: five unchanged feed secrets installed with restricted numeric UIDs")
        print("PASS: source custody preserved; no Docker or service changes")
    elif args.verify:
        if args.approval:
            raise ValueError(DENIED)
        check_release(args.expected_sha, install=True)
        verify_destinations()
        print("PASS: five runtime secrets independently verified; originals unchanged")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError,
            UnicodeError, subprocess.TimeoutExpired):
        raise SystemExit(DENIED)
