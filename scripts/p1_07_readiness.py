#!/usr/bin/env python3
"""P1-07 fail-closed, read-only validation of an opt-in Compose data stack.

Input: normalized JSON from `docker compose ... config --format json`.
This script never contacts Docker or changes any running service.
"""
import json
import sys


def check(config: dict) -> None:
    services = config.get("services", {})
    for name in ("web", "api", "worker", "postgres", "redis"):
        if name not in services:
            raise ValueError(f"missing service: {name}")
    networks = config.get("networks", {})
    if not networks.get("backend", {}).get("internal"):
        raise ValueError("backend network must be internal")

    for name, service in services.items():
        if service.get("ports") or service.get("network_mode") == "host":
            raise ValueError(f"{name}: host exposure prohibited")
        if service.get("privileged"):
            raise ValueError(f"{name}: privileged mode prohibited")
        if not service.get("profiles"):
            raise ValueError(f"{name}: must require an opt-in profile")
        if not service.get("mem_limit") or not service.get("cpus"):
            raise ValueError(f"{name}: resource limits required")

    for name in ("postgres", "redis", "worker"):
        if set(services[name].get("networks", {})) != {"backend"}:
            raise ValueError(f"{name}: must be isolated to backend network")

    pg = services["postgres"]
    if pg.get("environment", {}).get("POSTGRES_PASSWORD_FILE") != "/run/secrets/postgres_password":
        raise ValueError("PostgreSQL must load password from Docker secret")
    if "postgres_password" not in pg.get("secrets", []):
        # Compose normalizes secrets as objects, not always strings.
        mounted = [s.get("source") if isinstance(s, dict) else s for s in pg.get("secrets", [])]
        if "postgres_password" not in mounted:
            raise ValueError("PostgreSQL password secret missing")

    redis = services["redis"]
    command = redis.get("command", [])
    if isinstance(command, str):
        command = command.split()
    if "--protected-mode" not in command:
        raise ValueError("Redis protected mode must be explicit")
    i = command.index("--protected-mode")
    if len(command) <= i + 1 or command[i + 1] != "yes":
        raise ValueError("Redis protected mode must stay enabled")

    redis_secrets = [item.get("source") if isinstance(item, dict) else item for item in redis.get("secrets", [])]
    if "redis_acl" not in redis_secrets or "/run/secrets/redis_acl" not in command:
        raise ValueError("Redis must require the operator-provisioned ACL secret")
    if "redis_acl" not in config.get("secrets", {}):
        raise ValueError("Redis ACL secret must be declared")

    # P1-07 must not activate the unfinished worker or an unauthenticated Redis
    # deployment simply by validating the existing base compose configuration.
    if services["worker"].get("restart") not in ("no", "none"):
        raise ValueError("scaffold worker must not be set to restart continuously")


if __name__ == "__main__":
    try:
        check(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"P1-07 readiness FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)
    print("P1-07 readiness PASS: offline structure and isolation only (not deployment approval)")
