#!/usr/bin/env python3
"""Pure Redis 8 AOF capture-window risk assessor (no Docker, Redis, or I/O).

The caller supplies *redacted* observations collected by a separately reviewed
read-only operator. This never copies live AOF data, freezes writes, authorizes
maintenance, or proves atomicity of a live snapshot.

The two endpoint observations cannot rule out *all* concurrent filesystem
events or manual rewrites. Require independent provenance, rewrite controls,
archive checksum verification and isolated replay before recovery acceptance.
"""
from __future__ import annotations

import re

REFUSED = "REFUSED: Redis 8 read-only capture observation is not stable"
EXPECTED_IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
EXPECTED_VOLUME = "videonews-studio_redis_p109_restored"
IMAGE_SHA = re.compile(r"[a-f0-9]{64}\Z")
NAMES = re.compile(
    r"appendonly\.aof\.([1-9][0-9]*)\.(?:base\.(?:rdb|aof)|incr\.aof)\Z"
)
AOF_INT = (
    "aof_enabled",
    "aof_rewrite_in_progress",
    "aof_rewrite_scheduled",
    "aof_rewrites",
    "aof_current_size",
    "aof_base_size",
    "aof_pending_bio_fsync",
)
AOF_STATUS = ("aof_last_bgrewrite_status", "aof_last_write_status")
EXPECTED = {"container_id", "image", "volume", "uptime_seconds",
            "aof", "files"}


def refuse() -> None:
    raise ValueError(REFUSED)


def number(value: object, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        refuse()
    return value


def validate(observation: dict) -> None:
    if not isinstance(observation, dict) or set(observation) != EXPECTED:
        refuse()
    if (not isinstance(observation["container_id"], str)
            or not IMAGE_SHA.fullmatch(observation["container_id"])
            or observation["image"] != EXPECTED_IMAGE
            or observation["volume"] != EXPECTED_VOLUME):
        refuse()
    number(observation["uptime_seconds"])
    aof = observation["aof"]
    if (not isinstance(aof, dict)
            or set(aof) != set(AOF_INT) | set(AOF_STATUS)):
        refuse()
    for name in AOF_INT:
        number(aof[name])
    if (aof["aof_enabled"] != 1
            or aof["aof_rewrite_in_progress"] != 0
            or aof["aof_rewrite_scheduled"] != 0
            or aof["aof_last_bgrewrite_status"] != "ok"
            or aof["aof_last_write_status"] != "ok"
            or aof["aof_current_size"] <= 0
            or aof["aof_base_size"] <= 0):
        refuse()
    records = observation["files"]
    if not isinstance(records, list) or not 2 <= len(records) <= 11:
        refuse()
    seen: set[str] = set()
    for item in records:
        if (not isinstance(item, dict)
                or set(item) != {
                    "name", "device", "inode", "size", "mtime_ns", "ctime_ns"
                }):
            refuse()
        name = item["name"]
        if not isinstance(name, str) or not NAMES.fullmatch(name) or name in seen:
            refuse()
        seen.add(name)
        for field in ("device", "inode", "size", "mtime_ns", "ctime_ns"):
            number(item[field], minimum=1)


def assess_window(before: dict, after: dict) -> dict:
    """Reject known rewrite, reload, startup, modified-source and health risks.

    This returns *observational stability*, not snapshot consistency.
    Even a PASS does not grant permission to copy or restart Redis.
    """
    validate(before)
    validate(after)
    if (before["container_id"] != after["container_id"]
            or after["uptime_seconds"] < before["uptime_seconds"]
            or before["files"] != after["files"]):
        refuse()
    for field in ("aof_rewrites", "aof_current_size", "aof_base_size"):
        if before["aof"][field] != after["aof"][field]:
            refuse()
    # Guard against a source that still has an AOF fsync operation outstanding.
    if (before["aof"]["aof_pending_bio_fsync"] != 0
            or after["aof"]["aof_pending_bio_fsync"] != 0):
        refuse()
    return {
        "observation_stable": True,
        "source_volume_identity_checked": True,
        "no_rewrite_observed_at_endpoints": True,
        "source_file_metadata_unchanged": True,
        "point_in_time_consistency_proven": False,
        "independent_backup_verified": False,
        "isolated_redis_replay_verified": False,
        "production_capture_authorized": False,
        "redis_only_cutover_authorized": False,
    }
