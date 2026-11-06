#!/usr/bin/env python3
"""Read-only NASA source-export/worker-checkpoint/SQL-anchor parity witness.

No key material, registry entries, source URLs or database query errors are
printed. This is *not* an operator approval to poll or publish.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from urllib.parse import urlsplit

ROOT = Path("/home/ap/www/videonews-studio")
BASE = Path("/var/lib/videonews-studio/p2-signed-source")
PIN = re.compile(r"[a-f0-9]{40}\Z")
DENIED = "REFUSED: P2-02 NASA signed-SQL parity could not be established"
MAX_BYTES = 49152
REVISION = 10


def command(args: list[str], payload: str | None = None, cap: int = 65536) -> str:
    try:
        proc = subprocess.run(
            args, input=payload, text=True, capture_output=True,
            timeout=30, check=False,
        )
        if proc.returncode != 0 or len(proc.stdout) > cap:
            raise RuntimeError(DENIED)
        return proc.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(DENIED) from None


def release(sha: str) -> None:
    if os.geteuid() != 0 or not PIN.fullmatch(sha):
        raise RuntimeError(DENIED)
    git = ["git", "-c", "safe.directory=" + str(ROOT), "-C", str(ROOT)]
    if (command(git + ["branch", "--show-current"]) != "main"
            or command(git + ["rev-parse", "HEAD"]) != sha
            or command(git + ["status", "--porcelain"]) != ""):
        raise RuntimeError(DENIED)


def protected_read(path: Path, uid: int, gid: int, mode: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid
                or info.st_gid != gid or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != mode
                or not 1 < info.st_size <= MAX_BYTES
                or os.path.realpath(path) != str(path)):
            raise RuntimeError(DENIED)
        data = os.read(fd, MAX_BYTES + 1)
        after = os.fstat(fd)
        if (len(data) != info.st_size or after.dev != info.dev
                or after.ino != info.ino
                or after.size != info.size
                or after.mtime_ns != info.mtime_ns
                or after.ctime_ns != info.ctime_ns):
            raise RuntimeError(DENIED)
        return data
    finally:
        os.close(fd)


def host(source: object) -> str | None:
    if not isinstance(source, dict) or not isinstance(source.get("baseUrl"), str):
        return None
    try:
        parts = urlsplit(source["baseUrl"])
        if (parts.scheme != "https" or not parts.hostname
                or parts.username is not None or parts.password is not None
                or parts.port is not None):
            return None
        return parts.hostname
    except ValueError:
        return None


def registry_parity(
    database_sources: object, signed_sources: object, approved_hosts: object
) -> dict[str, bool]:
    """The signed export selects approved-host entries, not every DB entry."""
    false = {
        "full_registry_equal": False,
        "approved_host_subset_equal": False,
        "approved_sources_only_on_granted_hosts": False,
    }
    if (not isinstance(database_sources, list)
            or not isinstance(signed_sources, list)
            or not isinstance(approved_hosts, list)
            or len(database_sources) > 20
            or len(signed_sources) > 20
            or not all(isinstance(x, str) for x in approved_hosts)
            or len(set(approved_hosts)) != len(approved_hosts)
            or not all(host(x) for x in database_sources + signed_sources)):
        return false
    # DB can include pending/blocked sources on hosts with no grant.
    # Every source on a granted host (including blocked child scopes) MUST
    # appear in the signed export, with exact immutable source metadata.
    included = [x for x in database_sources if host(x) in approved_hosts]
    return {
        "full_registry_equal": database_sources == signed_sources,
        "approved_host_subset_equal": sorted(included, key=lambda x: x["id"]) ==
                                      sorted(signed_sources, key=lambda x: x["id"]),
        "approved_sources_only_on_granted_hosts": all(
            x.get("status") != "approved" or host(x) in approved_hosts
            for x in database_sources
        ),
    }


def sql_read(digest: str) -> dict[str, object]:
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise RuntimeError(DENIED)
    sql = f"""
SELECT jsonb_build_object(
  'source_revision',
    (SELECT revision FROM vns.admin_source_registry WHERE singleton),
  'sources',
    (SELECT sources FROM vns.admin_source_registry WHERE singleton),
  'host_revision',
    (SELECT revision FROM vns.admin_source_host_approvals WHERE singleton),
  'approved_hosts',
    (SELECT approved_hosts FROM vns.admin_source_host_approvals WHERE singleton),
  'anchor_digest_ok',
    COALESCE((
      SELECT source_revision=10 AND host_approval_revision=10
         AND envelope_sha256='{digest}'
      FROM vns_source_anchor.high_water
      WHERE anchor_id='source-export'
    ), false),
  'policy_ok',
    EXISTS(
      SELECT 1 FROM vns_source_anchor.trust_policy_high_water h
      JOIN vns_source_anchor.trust_policy_approvals a
        USING (policy_revision)
      WHERE h.singleton AND h.policy_revision=1
        AND h.policy_sha256=a.policy_sha256
    )
);
"""
    raw = command([
        "docker", "exec", "-i",
        "-e", "PGOPTIONS=-c default_transaction_read_only=on "
              "-c statement_timeout=10000 -c lock_timeout=3000",
        "videonews-studio-postgres-1",
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews",
    ], sql, cap=65536)
    row = json.loads(raw)
    if not isinstance(row, dict) or set(row) != {
        "source_revision", "sources", "host_revision", "approved_hosts",
        "anchor_digest_ok", "policy_ok",
    }:
        raise RuntimeError(DENIED)
    return row


def inspect(sha: str) -> dict[str, object]:
    release(sha)
    # The signer and stage are independently verified before interpreting
    # signed paths. This command has no signing private-key reads/writes.
    stage_ok = True
    try:
        command([
            "node", str(ROOT / "scripts/p2_02_signed_source_stage_refresh.mjs"),
            "--verify", "--expected-sha", sha,
        ])
    except RuntimeError:
        stage_ok = False
    report: dict[str, object] = {
        "scope": "p2_02_nasa_signed_sql_parity_readonly",
        "release": sha,
        "publisher_signature_stage_valid": stage_ok,
        "stage_file_valid": False,
        "worker_inbox_file_valid": False,
        "checkpoint_file_valid": False,
        "stage_equals_worker_inbox": False,
        "checkpoint_matches_inbox_10_10": False,
        "database_readable": False,
        "sql_source_revision_10": False,
        "sql_host_revision_10": False,
        "sql_anchor_digest_matches": False,
        "sql_trust_policy_matches": False,
        "sql_hosts_equal_signed_hosts": False,
        "sql_full_registry_equal_signed": False,
        "sql_approved_host_subset_equal_signed": False,
        "sql_approved_sources_only_on_granted_hosts": False,
        "status": "blocked",
        "feed_started": False,
        "database_changed": False,
        "queue_changed": False,
        "checkpoint_changed": False,
        "production_authorized": False,
    }
    stage = inbox = cp = None
    for key, path, uid, gid, mode in (
        ("stage_file_valid", BASE / "handoff-staging/source-export.signed.json",
         10003, 10002, 0o640),
        ("worker_inbox_file_valid", BASE / "worker-inbox/source-export.signed.json",
         10002, 10002, 0o600),
        ("checkpoint_file_valid", BASE / "worker-checkpoint/source-export.checkpoint.json",
         10002, 10002, 0o600),
    ):
        try:
            value = protected_read(path, uid, gid, mode)
            report[key] = True
            if key == "stage_file_valid":
                stage = value
            elif key == "worker_inbox_file_valid":
                inbox = value
            else:
                cp = value
        except (OSError, RuntimeError):
            pass
    report["stage_equals_worker_inbox"] = (
        stage is not None and inbox is not None and stage == inbox
    )
    signed = None
    if inbox is not None and cp is not None and stage_ok:
        try:
            envelope = json.loads(inbox)
            signed = envelope["export"]
            checkpoint = json.loads(cp)
            digest = hashlib.sha256(inbox).hexdigest()
            report["checkpoint_matches_inbox_10_10"] = (
                signed["sourceRevision"] == REVISION
                and signed["hostApprovalRevision"] == REVISION
                and checkpoint == {
                    "version": 1,
                    "sourceRevision": REVISION,
                    "hostApprovalRevision": REVISION,
                    "envelopeSha256": digest,
                }
            )
        except (ValueError, TypeError, KeyError):
            pass
    if signed is not None and stage_ok:
        try:
            row = sql_read(hashlib.sha256(inbox).hexdigest())
            report["database_readable"] = True
            report["sql_source_revision_10"] = row["source_revision"] == REVISION
            report["sql_host_revision_10"] = row["host_revision"] == REVISION
            report["sql_anchor_digest_matches"] = row["anchor_digest_ok"] is True
            report["sql_trust_policy_matches"] = row["policy_ok"] is True
            signed_hosts = signed["allowedHosts"]
            db_hosts = row["approved_hosts"]
            report["sql_hosts_equal_signed_hosts"] = (
                isinstance(db_hosts, list) and isinstance(signed_hosts, list)
                and sorted(db_hosts) == sorted(signed_hosts)
            )
            parity = registry_parity(
                row["sources"],
                json.loads(signed["registryJson"])["sources"],
                signed_hosts,
            )
            for key, value in parity.items():
                report["sql_" + key.replace("full_registry_equal", "full_registry_equal_signed")
                       .replace("approved_host_subset_equal", "approved_host_subset_equal_signed")] = value
        except (RuntimeError, TypeError, KeyError, ValueError):
            pass

    required = (
        "publisher_signature_stage_valid", "stage_file_valid", "worker_inbox_file_valid",
        "checkpoint_file_valid", "stage_equals_worker_inbox",
        "checkpoint_matches_inbox_10_10", "database_readable",
        "sql_source_revision_10", "sql_host_revision_10",
        "sql_anchor_digest_matches", "sql_trust_policy_matches",
        "sql_hosts_equal_signed_hosts", "sql_approved_host_subset_equal_signed",
        "sql_approved_sources_only_on_granted_hosts",
    )
    if all(report[k] is True for k in required):
        report["status"] = "parity_reviewable"
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="P2 NASA no-write source/SQL witness")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.expected_sha), sort_keys=True))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError):
        raise SystemExit(DENIED) from None


if __name__ == "__main__":
    main()
