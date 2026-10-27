#!/usr/bin/env python3
"""P2-02 Stage A: read-only VPS inventory. No secret, env or raw Docker inspect.

The output is a deliberately redacted status report, not a deployment permit.
All subprocesses are fixed-argument read-only probes with bounded timeouts.
"""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Callable

PROJECT = "videonews-studio"
SERVICES = (
    "postgres",
    "redis",
    "feed-observer",
    "feed-scheduler",
    "feed-producer",
    "feed-producer-continuous",
    "feed-consumer",
)
PRODUCERS = ("feed-observer", "feed-scheduler", "feed-producer", "feed-producer-continuous")
SHA = re.compile(r"^[0-9a-f]{40}$")
PROJECT_NAME = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
SAFE_STATES = {"running", "exited", "created", "restarting", "paused", "dead", "removing"}


def _command(argv: list[str], cwd: str) -> tuple[int, str]:
    """Suppress stderr; no raw error texts, paths or authentication data are exported."""
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=8,
            check=False,
        )
        return result.returncode, result.stdout[:16384]
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def _health(status: str) -> str:
    if "(unhealthy)" in status:
        return "unhealthy"
    if "(healthy)" in status:
        return "healthy"
    if "(health: starting)" in status:
        return "starting"
    return "not_reported"


def inspect_stage_a(
    *,
    repo_dir: str,
    expected_sha: str,
    project_name: str = PROJECT,
    run: Callable[[list[str], str], tuple[int, str]] = _command,
    free_space: Callable[[str], os.statvfs_result] = os.statvfs,
) -> dict:
    if not SHA.fullmatch(expected_sha) or not PROJECT_NAME.fullmatch(project_name):
        raise ValueError("Invalid release or project selection")
    if not Path(repo_dir).is_absolute() or ".." in Path(repo_dir).parts:
        raise ValueError("Repository path must be absolute without parent traversal")
    code, value = run(["git", "rev-parse", "--verify", "HEAD"], repo_dir)
    checkout_sha = value.strip() if code == 0 and SHA.fullmatch(value.strip()) else None
    code, value = run(["git", "status", "--porcelain", "--untracked-files=no"], repo_dir)
    clean = (value == "") if code == 0 else None

    # Compose project-label filter prevents observing unrelated projects. Never
    # request docker inspect, env, mounts, credentials, labels dump or logs.
    fmt = '{{.Label "com.docker.compose.service"}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}'
    code, raw = run(
        [
            "docker", "ps", "--all",
            "--filter", "label=com.docker.compose.project=" + project_name,
            "--format", fmt,
        ],
        repo_dir,
    )
    docker_accessible = code == 0
    observed: dict[str, list[dict]] = {name: [] for name in SERVICES}
    if docker_accessible:
        for line in raw.splitlines():
            parts = line.split("\t")
            if len(parts) != 4:
                continue
            service, state, status, ports = parts
            if service not in observed:
                continue
            observed[service].append({
                "state": state if state in SAFE_STATES else "unknown",
                "health": _health(status),
                # Only a bound host-port mapping has the Docker -> marker.
                "host_ports_published": "->" in ports,
            })
    services = {}
    for name, records in observed.items():
        services[name] = records[0] if len(records) == 1 else {
            "state": "not_observed" if not records else "ambiguous",
            "health": "unknown",
            "host_ports_published": None,
        }
    try:
        stat = free_space("/")
        total = stat.f_blocks * stat.f_frsize
        available = stat.f_bavail * stat.f_frsize
        resources = {
            "root_available_gib": round(available / (1024**3), 1),
            "root_used_percent": round(100 * (1 - available / total), 1) if total else None,
        }
    except OSError:
        resources = {"root_available_gib": None, "root_used_percent": None}

    present_producers = [
        name for name in PRODUCERS
        if services[name]["state"] in ("running", "restarting", "paused")
    ]
    ambiguous = any(entry["state"] == "ambiguous" for entry in services.values())
    exposed = any(entry["host_ports_published"] is True for entry in services.values())
    checks = {
        "expected_checkout_sha": checkout_sha == expected_sha,
        "tracked_worktree_clean": clean is True,
        "docker_inventory_accessible": docker_accessible,
        "no_ambiguous_feed_containers": not ambiguous and docker_accessible,
        "no_feed_host_ports": not exposed and docker_accessible and not ambiguous,
        "no_competing_feed_producers": len(present_producers) < 2 and docker_accessible and not ambiguous,
    }
    return {
        "schema_version": 1,
        "scope": "read_only_stage_a",
        "release": {
            "expected_sha": expected_sha,
            "checkout_sha": checkout_sha,
            "tracked_worktree_clean": clean,
        },
        "docker": {
            "project": project_name,
            "accessible": docker_accessible,
            "services": services,
        },
        "resources": resources,
        "checks": checks,
        "stage_a_readiness": "reviewable" if all(checks.values()) else "blocked",
        "independent_evidence": {
            "licensed_source_rights": "not_verified",
            "signer_and_remote_anchor_custody": "not_verified",
            "offsite_backup_and_restore": "not_verified",
            "beszel_alert_receipt": "not_verified",
            "one_slot_live_canary_and_rollback": "not_verified",
        },
        "production_authorized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Redacted read-only P2-02 VPS inspection")
    parser.add_argument("--repo", default="/home/ap/www/videonews-studio")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--project-name", default=PROJECT)
    args = parser.parse_args()
    try:
        result = inspect_stage_a(
            repo_dir=args.repo,
            expected_sha=args.expected_sha,
            project_name=args.project_name,
        )
    except (ValueError, TypeError):
        print(json.dumps({"status": "blocked", "reason": "invalid_inspection_inputs"}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["stage_a_readiness"] == "reviewable" else 2


if __name__ == "__main__":
    raise SystemExit(main())
