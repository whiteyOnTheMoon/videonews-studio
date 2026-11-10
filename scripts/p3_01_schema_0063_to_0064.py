#!/usr/bin/env python3
"""Controlled 0063-to-0064 asset-provenance schema gate; no media publication or worker."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

ROOT = Path("/home/ap/www/videonews-studio")
MIGRATION = ROOT / "db/migrations/0064_asset_provenance_catalog.up.sql"
CONTAINER = "videonews-studio-postgres-1"
DENIED = "REFUSED: 0064 asset-provenance schema gate unsafe; inspect state, do not retry"
APPROVAL_ENV = "VNS_P3_0064_SCHEMA_OPERATOR_APPROVED"
SHA_ENV = "VNS_P3_0064_EXPECTED_MAIN_SHA"
RECOVERY_ENV = "VNS_P3_0064_RECOVERY_VERIFIED"
APPROVAL = "INSTALL_ASSET_PROVENANCE_SCHEMA_ONLY_NO_RENDER_OR_PUBLICATION"
RECOVERY = "OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_ROLLBACK"
SHA_RE = re.compile(r"[a-f0-9]{40}\Z")
MD5_RE = re.compile(r"[a-f0-9]{32}\Z")
OLD = "0063_named_feed_inbox"
NEW = "0064_asset_provenance_catalog"

BASE_SQL = """
SELECT current_database()='videonews' AND current_user='vns'
 AND current_setting('is_superuser')='on'
 AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
 AND to_regclass('vns.assets') IS NOT NULL
 AND to_regclass('vns.videos') IS NOT NULL
 AND to_regclass('vns.scripts') IS NOT NULL
 AND to_regclass('vns.asset_uses') IS NULL
 AND to_regclass('vns.asset_rights_readiness') IS NULL
 AND to_regprocedure('vns.protect_asset_provenance()') IS NULL
 AND to_regprocedure('vns.validate_asset_usage_story()') IS NULL
 AND to_regprocedure('vns.named_feed_inbox_page(integer)') IS NOT NULL
 AND to_regprocedure('vns.named_feed_inbox_sources_page(integer)') IS NULL
 AND NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid='vns.assets'::regclass AND NOT attisdropped
     AND attname IN ('origin_url','creator','license_url','license_snapshot',
       'content_sha256','rights_flags')
 )
 AND (SELECT count(*)=0 FROM vns.feed_event_rankings
   WHERE approved_for_publication);
""".strip()

POST_SQL = """
SELECT current_database()='videonews' AND current_user='vns'
 AND current_setting('is_superuser')='on'
 AND to_regclass('vns.asset_uses') IS NOT NULL
 AND to_regclass('vns.asset_rights_readiness') IS NOT NULL
 AND to_regprocedure('vns.protect_asset_provenance()') IS NOT NULL
 AND to_regprocedure('vns.validate_asset_usage_story()') IS NOT NULL
 AND to_regprocedure('vns.named_feed_inbox_page(integer)') IS NOT NULL
 AND to_regprocedure('vns.named_feed_inbox_sources_page(integer)') IS NULL
 AND (SELECT count(*)=6 FROM pg_catalog.pg_attribute
   WHERE attrelid='vns.assets'::regclass AND NOT attisdropped
     AND attname IN ('origin_url','creator','license_url','license_snapshot',
       'content_sha256','rights_flags'))
 AND (SELECT count(*)=7 FROM pg_catalog.pg_constraint
   WHERE conrelid='vns.assets'::regclass
     AND conname LIKE 'assets_p3_%')
 AND (SELECT convalidated=false FROM pg_catalog.pg_constraint
   WHERE conrelid='vns.assets'::regclass
     AND conname='assets_p3_clearance_evidence_required')
 AND EXISTS (
   SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgrelid='vns.assets'::regclass AND tgname='protect_asset_provenance'
     AND NOT tgisinternal
 )
 AND EXISTS (
   SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgrelid='vns.asset_uses'::regclass
     AND tgname='validate_asset_usage_story' AND NOT tgisinternal
 )
 AND NOT has_table_privilege('vns_api_runtime','vns.asset_uses','SELECT')
 AND NOT has_table_privilege('vns_api_runtime','vns.asset_uses','INSERT')
 AND (SELECT count(*)=0 FROM vns.asset_rights_readiness
   WHERE render_allowed OR effective_rights_status<>'BLOCKED')
 AND (SELECT count(*)=0 FROM vns.feed_event_rankings
   WHERE approved_for_publication);
""".strip()

# Digest + counts computed exclusively inside PostgreSQL. No raw headlines,
# URLs, account identities, credentials, or signed source material in output.
STATE_SQL = """
SELECT md5(concat_ws('|',
 (SELECT count(*)::text FROM vns.assets),
 (SELECT count(*)::text FROM vns.assets WHERE rights_status='cleared'),
 (SELECT count(*)::text FROM vns.videos),
 (SELECT count(*)::text FROM vns.scripts),
 (SELECT count(*)::text FROM vns.feed_poll_candidates),
 (SELECT count(*)::text FROM vns.research_articles),
 (SELECT count(*)::text FROM vns.research_event_articles),
 (SELECT count(*)::text FROM vns.feed_event_rankings),
 (SELECT count(*)::text FROM vns.editor_accounts),
 (SELECT count(*)::text FROM vns.admin_source_audit),
 (SELECT count(*)::text FROM vns.admin_source_host_audit)
));
""".strip()

BLOCKED = {
    "source-publisher", "source-handoff-import", "feed-observer",
    "feed-scheduler", "feed-producer", "feed-producer-continuous",
    "feed-consumer", "feed-project-once", "feed-project-continuous",
}


def run(argv: list[str], *, stdin: str | None = None, timeout: int = 30) -> str:
    try:
        p = subprocess.run(
            argv, input=stdin, text=True, capture_output=True, check=False,
            timeout=timeout, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"),
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(DENIED) from None
    if p.returncode or len(p.stdout) > 16384:
        raise RuntimeError(DENIED)
    return p.stdout.strip()


def git(*args: str) -> str:
    return run(["git", "--no-optional-locks", "-C", str(ROOT), *args])


def release(expected: str) -> None:
    if (not SHA_RE.fullmatch(expected) or os.geteuid() != 1000
            or pwd.getpwuid(os.getuid()).pw_name != "ap"):
        raise RuntimeError(DENIED)
    index = (ROOT / ".git/index").lstat()
    if (not stat.S_ISREG(index.st_mode) or index.st_nlink != 1
            or index.st_uid != 1000 or index.st_gid != 1000
            or stat.S_IMODE(index.st_mode) != 0o600):
        raise RuntimeError(DENIED)
    if (git("branch", "--show-current") != "main"
            or git("rev-parse", "HEAD") != expected
            or git("status", "--porcelain") != ""
            or git("ls-remote", "origin", "refs/heads/main").split()[0] != expected):
        raise RuntimeError(DENIED)


def idle_database() -> None:
    health = run([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', CONTAINER,
    ])
    if health != "videonews-studio|postgres|healthy":
        raise RuntimeError(DENIED)
    live = run([
        "docker", "ps", "--filter",
        "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}',
    ]).splitlines()
    if any(service in BLOCKED for service in live):
        raise RuntimeError(DENIED)


def asset_writers_idle() -> None:
    """Apply-only maintenance gate: active API/worker may change asset rows."""
    running = run([
        "docker", "ps",
        "--filter", "label=com.docker.compose.project=videonews-studio",
        "--filter", "status=running",
        "--format", '{{.Label "com.docker.compose.service"}}',
    ]).splitlines()
    if any(service in {"api", "worker"} for service in running):
        raise RuntimeError(DENIED)


def migration_source() -> str:
    item = MIGRATION.lstat()
    if (MIGRATION.is_symlink() or not stat.S_ISREG(item.st_mode)
            or item.st_uid != 1000
            or stat.S_IMODE(item.st_mode) & 0o022
            or not 1000 <= item.st_size <= 15000):
        raise RuntimeError(DENIED)
    data = MIGRATION.read_text("utf-8")
    if (data.rstrip("\n") != git("show", "HEAD:db/migrations/0064_asset_provenance_catalog.up.sql")
            or data.count("\nBEGIN;") != 1 or data.count("\nCOMMIT;") != 1
            or not data.rstrip().endswith("COMMIT;")
            or "VALUES ('0064_asset_provenance_catalog');" not in data
            or "CREATE VIEW vns.asset_rights_readiness AS" not in data
            or "REVOKE ALL ON vns.asset_uses, vns.asset_rights_readiness FROM PUBLIC;"
            not in data):
        raise RuntimeError(DENIED)
    return data


def query(sql: str, *, write: bool = False) -> str:
    opts = "-c lock_timeout=3000 -c statement_timeout=45000"
    opts += (" -c default_transaction_read_only=off" if write
             else " -c default_transaction_read_only=on")
    return run([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + opts, CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews",
    ], stdin=sql + "\n", timeout=60)


def versions() -> list[str]:
    names = [f.name.removesuffix(".up.sql")
             for f in sorted((ROOT / "db/migrations").glob("*.up.sql"))]
    if (len(names) != 65 or names[-3:] != [OLD, NEW, "0065_named_feed_inbox_sources"]
            or any(int(n[:4]) != i for i, n in enumerate(names, 1))):
        raise RuntimeError(DENIED)
    return names


def ledger() -> list[str]:
    return query("SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


def snapshot() -> str:
    digest = query(STATE_SQL)
    if not MD5_RE.fullmatch(digest):
        raise RuntimeError(DENIED)
    return digest


def installed(names: list[str]) -> int:
    existing = ledger()
    if existing == names[:63] and query(BASE_SQL) == "t":
        return 63
    if existing == names[:64] and query(POST_SQL) == "t":
        return 64
    raise RuntimeError(DENIED)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="P3-01 exact schema 0064 operator gate")
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--status", action="store_true")
    choice.add_argument("--preflight", action="store_true")
    choice.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args(argv)
    release(args.expected_sha)
    idle_database()
    ddl = migration_source()
    names = versions()
    state = installed(names)

    if args.status:
        print("PASS: schema", state, "and personal rights validated")
        print("INFO: no feed, queue, publisher or database mutation")
        return
    if state != 63:
        raise RuntimeError(DENIED)
    before = snapshot()
    if args.preflight:
        print("PASS: schema 0063; ready for 0064 asset-provenance review")
        print("INFO: read-only; no publication or worker start")
        return

    if (os.environ.get(APPROVAL_ENV) != APPROVAL
            or os.environ.get(SHA_ENV) != args.expected_sha
            or os.environ.get(RECOVERY_ENV) != RECOVERY):
        raise RuntimeError(DENIED)
    # Existing API and worker must be stopped for this asset DDL maintenance.
    # This check is not performed for --status or --preflight.
    asset_writers_idle()
    # Separate, exact, last-second recheck. Never retry an ambiguous SQL write.
    release(args.expected_sha)
    idle_database()
    asset_writers_idle()
    if installed(names) != 63 or snapshot() != before:
        raise RuntimeError(DENIED)
    query(ddl, write=True)
    if installed(names) != 64 or snapshot() != before:
        raise RuntimeError(DENIED)
    print("PASS: 0064 asset provenance installed, existing row counts unchanged")
    print("INFO: API/Worker restart and publication remain separately authorized")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, PermissionError,
            UnicodeError, subprocess.TimeoutExpired, IndexError):
        raise SystemExit(DENIED) from None
