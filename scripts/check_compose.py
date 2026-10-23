#!/usr/bin/env python3
"""Validate the normalized Docker Compose file without starting containers."""
import json
import sys


def verify(data):
    expected = {"web", "api", "worker", "postgres", "redis", "caddy"}
    services = data.get("services", {})
    if set(services) != expected:
        raise ValueError(f"Expected exactly {sorted(expected)}, found {sorted(services)}")
    for name, service in services.items():
        if service.get("ports") or service.get("network_mode") == "host":
            raise ValueError(f"{name} must not publish ports or share host networking")
        if service.get("privileged"):
            raise ValueError(f"{name} must not be privileged")
        if not service.get("profiles"):
            raise ValueError(f"{name} must have an opt-in profile")
        if service.get("mem_limit") is None or service.get("cpus") is None:
            raise ValueError(f"{name} must have explicit runtime resource caps")
    networks = data.get("networks", {})
    if not any(net.get("internal") for net in networks.values()):
        raise ValueError("At least one internal-only backend network is required")
    for name in ["postgres", "redis", "worker"]:
        for network in services[name].get("networks", {}):
            if "backend" not in network:
                raise ValueError(f"{name} unexpectedly joined a non-backend network")
    if services["redis"].get("command")[-1] != "yes":
        raise ValueError("Redis protected mode must remain enabled")
    if "postgres_password" not in data.get("secrets", {}):
        raise ValueError("PostgreSQL must use a Compose secret")
    return True


if __name__ == "__main__":
    try:
        verify(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError) as exc:
        print(f"Compose security validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print("Compose structure/security validation passed")
