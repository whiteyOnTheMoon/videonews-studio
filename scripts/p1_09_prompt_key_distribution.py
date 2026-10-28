#!/usr/bin/env python3
"""P1-09: operator-only, non-overwriting AES-GCM prompt key distribution.

Copies exactly the existing 32-byte producer prompt key to the independent
API key directory. Never touches vendor master key, DB, Redis or containers.
--preflight and --verify are read-only. --apply needs exact SHA + approval.
"""
from __future__ import annotations

import hmac
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "secrets" / "vns-outbox"
TARGET_DIR = ROOT / "secrets" / "vns"
KEY = "provider-prompt-key"
APPROVAL = "VNS_P109_PROMPT_KEY_DISTRIBUTION_APPROVED"
SHA_PIN = "VNS_P109_PROMPT_KEY_EXPECTED_SHA"
ERROR = "REFUSED: P1-09 independent prompt key distribution preconditions failed"


def command(argv: list[str]) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=35, check=False
    )
    if result.returncode:
        raise RuntimeError(ERROR)
    return result.stdout.strip()


def operator(*, need_pin: bool = False) -> None:
    if os.geteuid() != 1000:
        raise PermissionError(ERROR)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(ERROR)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(ERROR)
    current = command(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    if not re.fullmatch(r"[0-9a-f]{40}", current):
        raise RuntimeError(ERROR)
    if need_pin:
        if (
            os.getenv(APPROVAL) != "COPY_EXISTING_PROMPT_KEY_ONLY"
            or os.getenv(SHA_PIN) != current
            or command(["git", "-C", str(ROOT), "ls-remote",
                        "origin", "refs/heads/main"]).split("\t")[0] != current
        ):
            raise RuntimeError(ERROR)


def private_directory(path: Path) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise PermissionError(ERROR)
        return fd
    except BaseException:
        os.close(fd)
        raise


def key_bytes(directory: int) -> bytearray:
    fd = os.open(
        KEY, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
    )
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) not in (0o400, 0o600)
            or info.st_size != 32
        ):
            raise PermissionError(ERROR)
        content = bytearray(os.read(fd, 33))
        if len(content) != 32:
            content[:] = b"\x00" * len(content)
            raise RuntimeError(ERROR)
        return content
    finally:
        os.close(fd)


def target_missing(directory: int) -> None:
    try:
        os.stat(KEY, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise FileExistsError(ERROR)


def preflight() -> None:
    operator()
    src = private_directory(SOURCE_DIR)
    dst = private_directory(TARGET_DIR)
    try:
        key = key_bytes(src)
        try:
            target_missing(dst)
        finally:
            key[:] = b"\x00" * len(key)
    finally:
        os.close(dst)
        os.close(src)


def verify() -> None:
    operator()
    src = private_directory(SOURCE_DIR)
    dst = private_directory(TARGET_DIR)
    first = second = None
    try:
        first = key_bytes(src)
        second = key_bytes(dst)
        if not hmac.compare_digest(first, second):
            raise RuntimeError(ERROR)
        # Not a hardlink; producer must never gain access to the API key path.
        a = os.stat(KEY, dir_fd=src, follow_symlinks=False)
        b = os.stat(KEY, dir_fd=dst, follow_symlinks=False)
        if (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino):
            raise RuntimeError(ERROR)
    finally:
        if first is not None:
            first[:] = b"\x00" * len(first)
        if second is not None:
            second[:] = b"\x00" * len(second)
        os.close(dst)
        os.close(src)


def apply() -> None:
    # Approval, clean release and all read-only checks before the file write.
    operator(need_pin=True)
    preflight()
    src = private_directory(SOURCE_DIR)
    dst = private_directory(TARGET_DIR)
    content = None
    try:
        content = key_bytes(src)
        target_missing(dst)
        old_umask = os.umask(0o077)
        try:
            fd = os.open(
                KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=dst
            )
        finally:
            os.umask(old_umask)
        # An interrupted write is not retried, overwritten or deleted.
        try:
            if os.write(fd, content) != 32:
                raise RuntimeError(ERROR)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(dst)
    finally:
        if content is not None:
            content[:] = b"\x00" * len(content)
        os.close(dst)
        os.close(src)
    verify()


def main(args: list[str]) -> None:
    if args == ["--preflight"]:
        preflight()
        print("PASS: existing producer prompt key valid; API destination absent")
    elif args == ["--verify"]:
        verify()
        print("PASS: separate API prompt key matches producer; no hardlinks or symlinks")
    elif args == ["--apply"]:
        apply()
        print("PASS: existing AES-GCM prompt key copied exclusively into API custody")
        print("No provider master key, DB, Redis, Docker or budget changed")
    else:
        raise ValueError(ERROR)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError, subprocess.TimeoutExpired):
        raise SystemExit(ERROR)
