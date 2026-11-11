#!/usr/bin/env python3
"""P2-02: unpause-only watchdog policy contract, NOT a production operator.

This module is import-only (no CLI) and has no implicit side effects. A future
separate user-systemd watchdog runner may import it after an independent
systemd timer and recovery plan are reviewed. NEVER call it for a live
container from existing production/maintenance code.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Callable

REFUSED = "REFUSED: Redis watchdog target identity changed"
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
VOLUME = "videonews-studio_redis_p109_restored"
CONTAINER = "videonews-studio-redis-1"


@dataclass(frozen=True)
class ExpectedTarget:
    id: str
    name: str
    image_ref: str
    image_id: str
    project: str
    service: str
    mount_type: str
    mount_identity: str


def refuse() -> None:
    raise ValueError(REFUSED)


def require_target(target: ExpectedTarget) -> None:
    if (not isinstance(target, ExpectedTarget)
            or not SHA256.fullmatch(target.id)
            or not isinstance(target.name, str)
            or not re.fullmatch(r"[a-z][a-z0-9-]{3,80}", target.name)
            or not isinstance(target.image_ref, str)
            or not target.image_ref.startswith("redis:8.4.8-alpine@sha256:")
            or not DIGEST.fullmatch(target.image_ref.split("@", 1)[-1])
            or not isinstance(target.image_id, str)
            or not DIGEST.fullmatch(target.image_id)
            or not isinstance(target.project, str)
            or not re.fullmatch(r"[a-z0-9-]{3,70}", target.project)
            or not isinstance(target.service, str)
            or not re.fullmatch(r"[a-z0-9-]{3,70}", target.service)
            or target.mount_type not in ("volume", "bind")
            or not isinstance(target.mount_identity, str)
            or not 3 <= len(target.mount_identity) <= 512):
        refuse()
    if target.name == CONTAINER and (
        target.image_ref != IMAGE
        or target.project != "videonews-studio"
        or target.service != "redis"
        or target.mount_type != "volume"
        or target.mount_identity != VOLUME
    ):
        refuse()


def classify(raw: dict, expected: ExpectedTarget) -> str:
    """Evaluate all target invariants without invoking the Docker daemon."""
    require_target(expected)
    if not isinstance(raw, dict):
        refuse()
    config = raw.get("Config")
    state = raw.get("State")
    mounts = raw.get("Mounts")
    host = raw.get("HostConfig")
    if (not isinstance(config, dict)
            or not isinstance(state, dict)
            or not isinstance(host, dict)
            or not isinstance(mounts, list)):
        refuse()
    labels = config.get("Labels")
    network = raw.get("NetworkSettings")
    if not isinstance(network, dict):
        refuse()
    ports = network.get("Ports")
    if (ports is not None
            and (not isinstance(ports, dict)
                 or any(value not in (None, []) for value in ports.values()))):
        refuse()
    if (raw.get("Id") != expected.id
            or raw.get("Name") != "/" + expected.name
            or raw.get("Image") != expected.image_id
            or config.get("Image") != expected.image_ref
            or not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != expected.project
            or labels.get("com.docker.compose.service") != expected.service
            or state.get("Running") is not True
            or type(state.get("Paused")) is not bool
            or state.get("Restarting") is not False
            or state.get("Dead") is not False
            or state.get("Status") != (
                "paused" if state.get("Paused") else "running"
            )
            or host.get("PortBindings") not in (None, {})
            ):
        refuse()
    data = [item for item in mounts if isinstance(item, dict)
            and item.get("Destination") == "/data"]
    if len(data) != 1 or data[0].get("Type") != expected.mount_type:
        refuse()
    if expected.mount_type == "volume":
        matched = data[0].get("Name") == expected.mount_identity
    else:
        matched = data[0].get("Source") == expected.mount_identity
    if not matched or data[0].get("RW") is not True:
        refuse()
    return "paused" if state["Paused"] else "running"


def unpause_verified(
    expected: ExpectedTarget,
    read_inspect: Callable[[str], dict],
    unpause: Callable[[str], None],
) -> dict:
    """Only unpause the pinned ID, then re-inspect; never pause/restart.

    Caller MUST provide Docker operations bound to an explicit local socket.
    This primitive itself never invokes Docker/systemd and is not scheduled.
    """
    before = classify(read_inspect(expected.id), expected)
    if before == "running":
        return {"identity_verified": True, "already_running": True,
                "unpause_attempted": False}
    unpause(expected.id)
    after = classify(read_inspect(expected.id), expected)
    if after != "running":
        refuse()
    return {"identity_verified": True, "already_running": False,
            "unpause_attempted": True}
