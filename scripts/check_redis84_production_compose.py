#!/usr/bin/env python3
"""Fail-closed comparison of base and Redis 8.4.8 production Compose."""
import json
import sys

IMAGE = (
    "redis:8.4.8-alpine@sha256:"
    "d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
)
VOLUME = "redis_p109_restored"


def verify(base, production):
    original = base["services"]
    changed = production["services"]

    if set(original) != set(changed):
        raise ValueError("Service inventory changed")

    for name in original:
        if name != "redis" and original[name] != changed[name]:
            raise ValueError("Non-Redis service changed: " + name)

    old = dict(original["redis"])
    new = dict(changed["redis"])

    if old.pop("image") != "redis:7-alpine":
        raise ValueError("Unexpected base Redis image")

    if new.pop("image") != IMAGE:
        raise ValueError("Redis image/digest mismatch")

    old_mounts = old.pop("volumes")
    new_mounts = new.pop("volumes")

    if (
        len(old_mounts) != 1
        or len(new_mounts) != 1
        or old_mounts[0].get("source") != "redis_data"
        or old_mounts[0].get("target") != "/data"
        or new_mounts[0].get("source") != VOLUME
        or new_mounts[0].get("target") != "/data"
    ):
        raise ValueError("Redis data volume mismatch")

    if old != new:
        raise ValueError("Unexpected Redis configuration change")

    if (
        "redis_data" not in base.get("volumes", {})
        or VOLUME not in production.get("volumes", {})
    ):
        raise ValueError("Persistent volume declaration missing")

    if (
        changed["redis"].get("ports")
        or changed["redis"].get("privileged")
        or changed["redis"].get("network_mode") == "host"
    ):
        raise ValueError("Unsafe Redis exposure")

    if changed["redis"].get("command", [])[-2:] != [
        "--protected-mode", "yes"
    ]:
        raise ValueError("Redis protected mode missing")

    secrets = changed["redis"].get("secrets", [])
    if (
        len(secrets) != 1
        or not isinstance(secrets[0], dict)
        or secrets[0].get("source") != "redis_acl"
        or secrets[0].get("target") != "/run/secrets/redis_acl"
    ):
        raise ValueError("Redis ACL secret missing or incorrectly mounted")

    return True


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: checker BASE.json PRODUCTION.json")
    try:
        with open(sys.argv[1], encoding="utf8") as f:
            base = json.load(f)
        with open(sys.argv[2], encoding="utf8") as f:
            production = json.load(f)
        verify(base, production)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print("REFUSED: Redis production Compose validation failed",
              file=sys.stderr)
        raise SystemExit(1) from None
    print("PASS: Redis 8.4.8 production Compose guard")
