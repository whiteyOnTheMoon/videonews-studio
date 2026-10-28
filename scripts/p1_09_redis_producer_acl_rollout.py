#!/usr/bin/env python3
"""P1-09 additive Redis producer ACL file rollout. Does not restart Redis.

--preflight: read-only inspect exact private ACL candidate and current users.
--prepare: create private merged ACL candidate + baseline SHA, no live change.
--verify: read-only verify byte-exact merge and unchanged original ACL.
--install-file: explicit SHA-locked operator action, preserves original ACL
  in private directory and atomically swaps the host file. Running Redis
  remains unchanged until separately reviewed container recreation.
--installed: read-only verify installed host file and saved original.

Never uses Redis AUTH, changes another user, runs ACL LOAD or restarts Docker.
"""
from __future__ import annotations

from hashlib import sha256
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

from p1_09_provider_outbox_custody import (
    ACL_CANDIDATE,
    REDIS_FILE,
    REDIS_USER,
    acl_line,
    secure_read,
)

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / "secrets"
PRIVATE = SECRETS / "vns-outbox"
ACL = "redis_acl"
MERGED = "redis-acl-with-producer"
BASELINE = "redis-acl-baseline-sha256"
BACKUP = "redis-acl-before-producer"
TEMP = ".redis_acl.p1_09_pending"
APPROVAL = "VNS_P109_REDIS_ACL_FILE_INSTALL_APPROVED"
PIN = "VNS_P109_REDIS_ACL_EXPECTED_SHA"
FAIL = "REFUSED: additive provider Redis ACL rollout preconditions failed"


def command(argv: list[str]) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=40, check=False
    )
    if result.returncode:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def operator(*, approving: bool = False) -> None:
    if os.geteuid() != 1000:
        raise PermissionError(FAIL)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    current = command(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    if not re.fullmatch(r"[0-9a-f]{40}", current):
        raise RuntimeError(FAIL)
    if approving and (
        os.getenv(APPROVAL) != "INSTALL_PRODUCER_ACL_FILE_ONLY"
        or os.getenv(PIN) != current
        or command(["git", "-C", str(ROOT), "ls-remote",
                    "origin", "refs/heads/main"]).split("\t")[0] != current
    ):
        raise RuntimeError(FAIL)


def private_fd(path: Path) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (info.st_uid != os.geteuid() or not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o700):
        os.close(fd)
        raise PermissionError(FAIL)
    return fd


def file_read(fd: int, name: str, *, mode: int, max_size: int = 8192) -> bytes:
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(handle)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != mode
            or info.st_size <= 0
            or info.st_size > max_size
        ):
            raise PermissionError(FAIL)
        data = os.read(handle, max_size + 1)
        if len(data) != info.st_size:
            raise RuntimeError(FAIL)
        return data
    finally:
        os.close(handle)


def absent(fd: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError(FAIL)


def baseline(current: bytes) -> list[str]:
    if not current.endswith(b"\n"):
        raise ValueError(FAIL)
    try:
        lines = current.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise ValueError(FAIL) from None
    names: list[str] = []
    for line in lines:
        if not line.strip() or line.startswith("#"):
            continue
        found = re.fullmatch(r"user ([A-Za-z0-9_-]+) (.+)", line)
        if not found:
            raise ValueError(FAIL)
        names.append(found.group(1))
        if found.group(1) == "default" and "off" not in found.group(2).split():
            raise ValueError(FAIL)
        if found.group(1) == "vns_worker" and "on" not in found.group(2).split():
            raise ValueError(FAIL)
    if (
        len(names) != len(set(names))
        or "default" not in names
        or "vns_worker" not in names
        or REDIS_USER in names
    ):
        raise ValueError(FAIL)
    return names


def desired(private: int, current: bytes) -> bytes:
    baseline(current)
    password = secure_read(private, REDIS_FILE, os.geteuid())
    candidate = secure_read(private, ACL_CANDIDATE, os.geteuid())
    if len(password) < 41 or not password.endswith(b"\n"):
        raise ValueError(FAIL)
    token = password[:-1].decode("ascii")
    if candidate != acl_line(token).encode("ascii"):
        raise ValueError(FAIL)
    combined = current + candidate
    if len(combined) > 8192:
        raise ValueError(FAIL)
    return combined


def safe_create(fd: int, name: str, content: bytes, mode: int) -> None:
    handle = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode, dir_fd=fd
    )
    try:
        if os.write(handle, content) != len(content):
            raise OSError(FAIL)
        os.fsync(handle)
    finally:
        os.close(handle)


def preflight() -> None:
    operator()
    private = private_fd(PRIVATE)
    secrets = private_fd(SECRETS)
    try:
        current = file_read(secrets, ACL, mode=0o644)
        desired(private, current)
        for item in (MERGED, BASELINE, BACKUP):
            absent(private, item)
        absent(secrets, TEMP)
    finally:
        os.close(secrets)
        os.close(private)


def prepare() -> None:
    preflight()
    private = private_fd(PRIVATE)
    secrets = private_fd(SECRETS)
    created: list[str] = []
    try:
        current = file_read(secrets, ACL, mode=0o644)
        combined = desired(private, current)
        digest = sha256(current).hexdigest().encode("ascii") + b"\n"
        for item, contents in ((MERGED, combined), (BASELINE, digest)):
            safe_create(private, item, contents, 0o600)
            created.append(item)
        os.fsync(private)
    except BaseException:
        for item in created:
            os.unlink(item, dir_fd=private)
        raise
    finally:
        os.close(secrets)
        os.close(private)


def verify() -> None:
    operator()
    private = private_fd(PRIVATE)
    secrets = private_fd(SECRETS)
    try:
        current = file_read(secrets, ACL, mode=0o644)
        expected = desired(private, current)
        digest = file_read(private, BASELINE, mode=0o600, max_size=128)
        combined = file_read(private, MERGED, mode=0o600)
        if (
            digest != sha256(current).hexdigest().encode("ascii") + b"\n"
            or combined != expected
        ):
            raise RuntimeError(FAIL)
        absent(private, BACKUP)
        absent(secrets, TEMP)
    finally:
        os.close(secrets)
        os.close(private)


def install_file() -> None:
    operator(approving=True)
    verify()
    private = private_fd(PRIVATE)
    secrets = private_fd(SECRETS)
    try:
        current = file_read(secrets, ACL, mode=0o644)
        content = file_read(private, MERGED, mode=0o600)
        if content != desired(private, current):
            raise RuntimeError(FAIL)
        old = os.stat(ACL, dir_fd=secrets, follow_symlinks=False)
        absent(private, BACKUP)
        absent(secrets, TEMP)
        safe_create(private, BACKUP, current, 0o600)
        os.fsync(private)
        safe_create(secrets, TEMP, content, 0o644)
        os.fsync(secrets)
        now = os.stat(ACL, dir_fd=secrets, follow_symlinks=False)
        if (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns) != (
            old.st_dev, old.st_ino, old.st_size, old.st_mtime_ns
        ):
            raise RuntimeError(FAIL)
        os.replace(TEMP, ACL, src_dir_fd=secrets, dst_dir_fd=secrets)
        os.fsync(secrets)
    finally:
        os.close(secrets)
        os.close(private)
    installed()


def installed() -> None:
    operator()
    private = private_fd(PRIVATE)
    secrets = private_fd(SECRETS)
    try:
        original = file_read(private, BACKUP, mode=0o600)
        digest = file_read(private, BASELINE, mode=0o600, max_size=128)
        combined = file_read(private, MERGED, mode=0o600)
        current = file_read(secrets, ACL, mode=0o644)
        if (
            digest != sha256(original).hexdigest().encode("ascii") + b"\n"
            or combined != desired(private, original)
            or current != combined
        ):
            raise RuntimeError(FAIL)
    finally:
        os.close(secrets)
        os.close(private)


def main(args: list[str]) -> None:
    if args == ["--preflight"]:
        preflight()
        print("PASS: existing Redis users and proposed producer candidate validated")
    elif args == ["--prepare"]:
        prepare()
        print("PASS: private additive ACL candidate staged; live Redis unchanged")
    elif args == ["--verify"]:
        verify()
        print("PASS: original Redis ACL unchanged; candidate has exactly one new user")
    elif args == ["--install-file"]:
        install_file()
        print("PASS: host ACL file replaced atomically, original preserved privately")
        print("Running Redis ACL unchanged; controlled container recreation still required")
    elif args == ["--installed"]:
        installed()
        print("PASS: installed host ACL retains original users and adds producer")
    else:
        raise ValueError(FAIL)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError,
            subprocess.TimeoutExpired, UnicodeError):
        raise SystemExit(FAIL)
