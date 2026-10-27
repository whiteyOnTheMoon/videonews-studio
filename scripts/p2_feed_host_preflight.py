#!/usr/bin/env python3
"""Read-only release gate for signed-source Docker host paths and UID isolation.

Never opens a secret, creates a directory, reads private key material,
starts a container or connects to a network. Not a substitute for operator
rights approval, external anchor trust or backup/restore acceptance.
"""

import argparse
import json
import os
from pathlib import Path
import stat
from dataclasses import dataclass
from typing import Callable, Mapping


PUBLISHER_UID = 10001
WORKER_UID = 10002
MIN_TRANSFER_UID = 10003
MAX_TRANSFER_UID = 60000
MAX_SIGNED_BYTES = 49152


class PreflightDenied(Exception):
    """Generic refusal. No path, credentials or hostnames appear in logs."""


@dataclass(frozen=True)
class Rule:
    name: str
    kind: str
    uid: int
    gid: int
    permissions: int


RULES = (
    Rule("VNS_P2_PUBLISHER_DIR", "directory", PUBLISHER_UID, PUBLISHER_UID, 0o700),
    Rule("VNS_P2_SIGNER_DB_PASSWORD_FILE", "file", PUBLISHER_UID, PUBLISHER_UID, 0o400),
    Rule("VNS_P2_PRIVATE_SIGNING_KEY_FILE", "file", PUBLISHER_UID, PUBLISHER_UID, 0o400),
    Rule("VNS_P2_HANDOFF_STAGING_DIR", "directory", -1, WORKER_UID, 0o750),
    Rule("VNS_P2_WORKER_INBOX_DIR", "directory", WORKER_UID, WORKER_UID, 0o700),
    Rule("VNS_P2_WORKER_CHECKPOINT_DIR", "directory", WORKER_UID, WORKER_UID, 0o700),
    Rule("VNS_P2_PINNED_PUBLIC_KEY_FILE", "file", 0, WORKER_UID, 0o440),
    Rule("VNS_P2_ANCHOR_DB_PASSWORD_FILE", "file", WORKER_UID, WORKER_UID, 0o400),
    Rule("VNS_P2_ANCHOR_CA_FILE", "file", 0, WORKER_UID, 0o440),
    Rule("VNS_P2_FEED_DB_PASSWORD_FILE", "file", WORKER_UID, WORKER_UID, 0o400),
    Rule("VNS_P2_FEED_REDIS_PASSWORD_FILE", "file", WORKER_UID, WORKER_UID, 0o400),
)


def _canonical(value: str) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise PreflightDenied()
    if os.path.normpath(value) != value or os.path.realpath(value) != value:
        raise PreflightDenied()
    if "/../" in value or "/./" in value or "\x00" in value:
        raise PreflightDenied()
    return value


def _check(path: str, rule: Rule, transfer_uid: int, inspect: Callable):
    info = inspect(path)
    if (rule.kind == "directory" and not stat.S_ISDIR(info.st_mode)) or (
        rule.kind == "file" and not stat.S_ISREG(info.st_mode)
    ):
        raise PreflightDenied()
    expected_uid = transfer_uid if rule.uid == -1 else rule.uid
    if (
        info.st_uid != expected_uid
        or info.st_gid != rule.gid
        or stat.S_IMODE(info.st_mode) != rule.permissions
    ):
        raise PreflightDenied()
    if rule.kind == "file" and (info.st_nlink != 1 or info.st_size < 1):
        raise PreflightDenied()


def inspect_feed_host(
    configuration: Mapping[str, str],
    phase: str,
    inspect: Callable = os.lstat,
) -> int:
    """Return number of satisfied checks, otherwise fail closed.

    Preparation checks provisioning; handoff adds stage; observer additionally
    requires a previously accepted worker checkpoint. No real files are read.
    """
    if phase not in ("prepare", "handoff", "observer"):
        raise PreflightDenied()
    try:
        uid_text = configuration["VNS_P2_TRANSFER_UID"]
        if not uid_text.isascii() or not uid_text.isdecimal():
            raise PreflightDenied()
        transfer_uid = int(uid_text)
        if not MIN_TRANSFER_UID <= transfer_uid <= MAX_TRANSFER_UID:
            raise PreflightDenied()
        paths = {rule.name: _canonical(configuration[rule.name]) for rule in RULES}
        if len(set(paths.values())) != len(paths):
            raise PreflightDenied()
        for rule in RULES:
            _check(paths[rule.name], rule, transfer_uid, inspect)
        count = len(RULES)
        if phase in ("handoff", "observer"):
            staged = _canonical(
                str(Path(paths["VNS_P2_HANDOFF_STAGING_DIR"]) / "source-export.signed.json")
            )
            _check(
                staged,
                Rule("staged", "file", transfer_uid, WORKER_UID, 0o640),
                transfer_uid,
                inspect,
            )
            if inspect(staged).st_size > MAX_SIGNED_BYTES:
                raise PreflightDenied()
            count += 1
        if phase == "observer":
            inbox = _canonical(
                str(Path(paths["VNS_P2_WORKER_INBOX_DIR"]) / "source-export.signed.json")
            )
            checkpoint = _canonical(
                str(Path(paths["VNS_P2_WORKER_CHECKPOINT_DIR"])
                    / "source-export.checkpoint.json")
            )
            for item in (inbox, checkpoint):
                _check(item, Rule("worker", "file", WORKER_UID, WORKER_UID, 0o600),
                       transfer_uid, inspect)
                if inspect(item).st_size > MAX_SIGNED_BYTES:
                    raise PreflightDenied()
            count += 2
        return count
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
        raise PreflightDenied() from None


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only signed feed host preflight")
    parser.add_argument("--phase", choices=("prepare", "handoff", "observer"),
                        required=True)
    args = parser.parse_args()
    # A real host audit must run as root to inspect protected secret metadata,
    # but this code NEVER reads their contents or changes permissions.
    try:
        if os.geteuid() != 0:
            raise PreflightDenied()
        checked = inspect_feed_host(os.environ, args.phase)
    except PreflightDenied:
        print(json.dumps({"status": "blocked", "check": "feed_host_permissions"}))
        return 2
    print(json.dumps({"status": "pass", "phase": args.phase, "checked": checked}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
