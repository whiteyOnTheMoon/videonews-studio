#!/usr/bin/env python3
"""Offline Redis 8 multipart-AOF archive validator; no production operations.

This module inspects only an *already copied* archive. It does not connect to
Redis, invoke Docker, make backups, write files, or authorize maintenance.
A matching inventory is NOT proof of provenance, a consistent live capture,
independent custody, successful AOF replay, or production recoverability.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat

MAX_TOTAL = 128 * 1024 * 1024
MAX_MANIFEST = 4096
MAX_FILES = 12
MANIFEST = "appendonly.aof.manifest"
BASE = re.compile(r"appendonly\.aof\.([1-9][0-9]*)\.base\.(rdb|aof)\Z")
INCR = re.compile(r"appendonly\.aof\.([1-9][0-9]*)\.incr\.aof\Z")
LINE = re.compile(
    r"file ([a-zA-Z0-9_.-]+) seq ([1-9][0-9]*) type ([bi])\Z"
)
REFUSED = "REFUSED: offline Redis 8 AOF archive validation failed"


def deny() -> None:
    raise ValueError(REFUSED)


def ordinary_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError:
        deny()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        deny()


def members(path: Path) -> set[str]:
    ordinary_directory(path)
    try:
        names = [entry.name for entry in os.scandir(path)]
    except OSError:
        deny()
    if len(names) != len(set(names)) or len(names) > MAX_FILES + 1:
        deny()
    return set(names)


def stable_file(path: Path, limit: int, *, include_bytes: bool = False) -> dict:
    """Hash a regular, single-linked file with no symlink following.

    Detect inode, size or timestamp changes observed during this single read.
    This is an offline guard; it is NOT an atomic snapshot of live Redis.
    """
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or not 0 < info.st_size <= limit):
            deny()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            if any(getattr(before, f) != getattr(info, f) for f in fields):
                deny()
            digest = hashlib.sha256()
            chunks: list[bytes] = []
            length = 0
            while True:
                block = os.read(fd, 65536)
                if not block:
                    break
                length += len(block)
                if length > limit:
                    deny()
                digest.update(block)
                if include_bytes:
                    chunks.append(block)
            after = os.fstat(fd)
            if (length != before.st_size
                    or any(getattr(after, f) != getattr(before, f)
                           for f in fields)):
                deny()
        finally:
            os.close(fd)
    except (OSError, OverflowError):
        deny()
    result = {"bytes": length, "sha256": digest.hexdigest()}
    if include_bytes:
        result["content"] = b"".join(chunks)
    return result


def manifest_entries(raw: bytes) -> list[str]:
    if not raw or len(raw) > MAX_MANIFEST or not raw.endswith(b"\n"):
        deny()
    try:
        data = raw.decode("ascii")
    except UnicodeDecodeError:
        deny()
    if "\r" in data or "\x00" in data:
        deny()
    lines = data[:-1].split("\n")
    if not 2 <= len(lines) <= MAX_FILES - 1:
        deny()
    found: list[str] = []
    base_count = 0
    increment_count = 0
    for index, line in enumerate(lines):
        item = LINE.fullmatch(line)
        if item is None:
            deny()
        name, sequence, kind = item.groups()
        base = BASE.fullmatch(name)
        increment = INCR.fullmatch(name)
        if kind == "b" and base and index == 0:
            valid_sequence = base.group(1)
            base_count += 1
        elif kind == "i" and increment and index > 0:
            valid_sequence = increment.group(1)
            increment_count += 1
        else:
            deny()
        if valid_sequence != sequence or name in found:
            deny()
        found.append(name)
    if base_count != 1 or increment_count < 1:
        deny()
    return found


def inspect_archive(root: Path) -> dict:
    """Return checksums internally; callers must not log them or job contents."""
    root = Path(root)
    if members(root) != {"appendonlydir"}:
        deny()
    part = root / "appendonlydir"
    files = members(part)
    head = stable_file(part / MANIFEST, MAX_MANIFEST, include_bytes=True)
    names = manifest_entries(head.pop("content"))
    if files != set(names) | {MANIFEST}:
        deny()
    entries = [{"name": MANIFEST, **head}]
    total = head["bytes"]
    for name in names:
        value = stable_file(part / name, MAX_TOTAL)
        total += value["bytes"]
        if total > MAX_TOTAL:
            deny()
        entries.append({"name": name, **value})
    return {
        "format": "vns-redis8-offline-archive-v1",
        "total_bytes": total,
        "files": entries,
    }


def compare_with_independent_inventory(root: Path, inventory: dict) -> dict:
    """Compare a copied archive to an inventory held separately from it.

    The caller must independently establish that the inventory is trustworthy
    and tied to a consistent source; no claim of source authenticity is made.
    """
    if (not isinstance(inventory, dict)
            or set(inventory) != {"format", "total_bytes", "files"}):
        deny()
    first = inspect_archive(root)
    if first != inventory:
        deny()
    if inspect_archive(root) != first:
        deny()
    return {"layout_checked": True, "inventory_match": True,
            "read_only": True, "restore_verified": False}
