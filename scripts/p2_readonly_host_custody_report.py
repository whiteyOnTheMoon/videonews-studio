#!/usr/bin/env python3
"""Sanitized, read-only P2 host custody status. Never opens a secret or source.

This is an operator *inventory*, not a release permit. The independently
provisioned external PostgreSQL anchor, source rights, signing key trust,
network behavior and admin HTTP login cannot be proven by file metadata.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Callable

from p2_02_stage_a_vps_inventory import inspect_stage_a, _command

REPO = "/home/ap/www/videonews-studio"
BASE = Path("/var/lib/videonews-studio")
SHA = re.compile(r"^[a-f0-9]{40}$")
SECRETS = {
    "vns_source_export_db_password": 10001,
    "vns_feed_db_password": 10002,
    "vns_feed_producer_redis_password": 10002,
    "vns_feed_consumer_redis_password": 10002,
    "vns_feed_project_db_password": 10004,
}

def guarded_file(path: Path, uid: int, gid: int, mode: int, *,
                 low: int = 1, high: int = 49152,
                 inspect: Callable = os.lstat) -> bool:
    try:
        m = inspect(path)
        return (
            stat.S_ISREG(m.st_mode)
            and m.st_uid == uid and m.st_gid == gid
            and stat.S_IMODE(m.st_mode) == mode
            and m.st_nlink == 1 and low <= m.st_size <= high
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def guarded_directory(path: Path, uid: int, gid: int, mode: int, *,
                      inspect: Callable = os.lstat) -> bool:
    try:
        m = inspect(path)
        return (
            stat.S_ISDIR(m.st_mode) and m.st_uid == uid and m.st_gid == gid
            and stat.S_IMODE(m.st_mode) == mode
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def inspect_custody(*, base: Path = BASE, inspect: Callable = os.lstat,
                    listdir: Callable = os.listdir) -> dict:
    """Only named status booleans, no path, credential or article content."""
    secret_dir = base / "p2-feed-runtime-secrets"
    signed = base / "p2-signed-source"
    pub = signed / "publisher"
    trust = signed / "trust-material"
    inbox = signed / "worker-inbox"
    checkpoint = signed / "worker-checkpoint"
    stage = signed / "handoff-staging"

    def names(directory: Path) -> set[str] | None:
        try:
            return set(listdir(directory))
        except (OSError, ValueError, TypeError):
            return None

    base_ok = guarded_directory(base, 0, 0, 0o700, inspect=inspect)
    secret_ok = (
        base_ok
        and guarded_directory(secret_dir, 0, 0, 0o700, inspect=inspect)
        and names(secret_dir) == set(SECRETS)
        and all(
            guarded_file(secret_dir / file, uid, uid, 0o400, low=41, high=129,
                         inspect=inspect)
            for file, uid in SECRETS.items()
        )
    )
    signed_ok = base_ok and guarded_directory(signed, 0, 0, 0o700, inspect=inspect)
    publisher_ok = (
        signed_ok and guarded_directory(pub, 10001, 10001, 0o700, inspect=inspect)
        and guarded_file(pub / "signing-private.pem", 10001, 10001, 0o400,
                         low=16, high=8192, inspect=inspect)
        and guarded_file(pub / "source-export.signed.json", 10001, 10001, 0o600,
                         inspect=inspect)
    )
    pinned_key_ok = (
        signed_ok and guarded_directory(trust, 0, 0, 0o700, inspect=inspect)
        and guarded_file(trust / "signing-public.pem", 0, 10002, 0o440,
                         low=16, high=8192, inspect=inspect)
    )
    worker_dirs_ok = (
        signed_ok
        and guarded_directory(inbox, 10002, 10002, 0o700, inspect=inspect)
        and guarded_directory(checkpoint, 10002, 10002, 0o700, inspect=inspect)
    )
    stage_ok = (
        signed_ok
        and guarded_directory(stage, 10003, 10002, 0o750, inspect=inspect)
        and names(stage) == {"source-export.signed.json"}
        and guarded_file(stage / "source-export.signed.json", 10003, 10002,
                         0o640, inspect=inspect)
    )
    received = worker_dirs_ok and guarded_file(
        inbox / "source-export.signed.json", 10002, 10002,
        0o600, inspect=inspect,
    )
    anchored_local = worker_dirs_ok and guarded_file(
        checkpoint / "source-export.checkpoint.json", 10002, 10002,
        0o600, inspect=inspect,
    )
    # File metadata cannot assert signature validity, independent remote
    # high-water, ownership of an external authority or source licenses.
    return {
        "runtime_secret_metadata": bool(secret_ok),
        "publisher_file_metadata": bool(publisher_ok),
        "public_key_file_metadata": bool(pinned_key_ok),
        "worker_directory_metadata": bool(worker_dirs_ok),
        "staging_file_metadata": bool(stage_ok),
        "inbox_file_metadata": bool(received),
        "local_checkpoint_file_metadata": bool(anchored_local),
    }


def inspect_host_status(*, expected_sha: str, stage: dict, branch: str,
                        custody: dict) -> dict:
    if not SHA.fullmatch(expected_sha):
        raise ValueError("Invalid expected release")
    safe_keys = {
        "runtime_secret_metadata", "publisher_file_metadata",
        "public_key_file_metadata", "worker_directory_metadata",
        "staging_file_metadata", "inbox_file_metadata",
        "local_checkpoint_file_metadata",
    }
    if (
        not isinstance(custody, dict) or set(custody) != safe_keys
        or any(type(v) is not bool for v in custody.values())
        or not isinstance(stage, dict) or not isinstance(branch, str)
    ):
        raise ValueError("Unexpected custody or repository metadata")
    release = stage.get("release") if isinstance(stage.get("release"), dict) else {}
    checks = stage.get("checks") if isinstance(stage.get("checks"), dict) else {}
    release_ok = (
        branch == "main"
        and stage.get("stage_a_readiness") == "reviewable"
        and release.get("expected_sha") == expected_sha
        and release.get("checkout_sha") == expected_sha
        and release.get("tracked_worktree_clean") is True
        and checks
        and all(type(value) is bool and value for value in checks.values())
    )
    return {
        "schema_version": 1,
        "scope": "read_only_p2_host_custody_status",
        "release_verified": bool(release_ok),
        "custody": custody,
        "read_only_metadata_preflight": "reviewable"
        if release_ok and all(custody.values()) else "incomplete",
        "independent_evidence": {
            "signature_and_signed_content": "not_verified",
            "licensed_source_rights": "not_verified",
            "external_anchor_tls_and_preapprovals": "not_verified",
            "feed_canary_restarts_and_failure_alert": "not_verified",
            "authenticated_admin_ranking_read": "not_verified",
        },
        "production_authorized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only P2 host file custody status")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        if os.geteuid() != 0 or not SHA.fullmatch(args.expected_sha):
            raise ValueError("Root and exact main SHA required")
        # Read-only fixed-argument git calls: root must not inherit the
        # operator's GitHub credentials or write global safe.directory state.
        def run(argv: list[str], cwd: str) -> tuple[int, str]:
            if argv[0] == "git":
                argv = ["git", "-c", "safe.directory=" + REPO, *argv[1:]]
            return _command(argv, cwd)

        code, branch = run(["git", "branch", "--show-current"], REPO)
        stage = inspect_stage_a(
            repo_dir=REPO, expected_sha=args.expected_sha, run=run,
        )
        custody = inspect_custody()
        result = inspect_host_status(
            expected_sha=args.expected_sha,
            stage=stage,
            branch=branch.strip() if code == 0 else "",
            custody=custody,
        )
    except (OSError, ValueError, TypeError, KeyError):
        result = {
            "schema_version": 1,
            "scope": "read_only_p2_host_custody_status",
            "read_only_metadata_preflight": "incomplete",
            "production_authorized": False,
        }
    print(json.dumps(result, sort_keys=True))
    # Incomplete is expected BEFORE staging and the first approved
    # checkpoint, and is not an instruction to bypass any gate.
    return 0 if result["read_only_metadata_preflight"] == "reviewable" else 2


if __name__ == "__main__":
    raise SystemExit(main())
