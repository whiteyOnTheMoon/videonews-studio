#!/usr/bin/env python3
"""Controlled one-time 0061→0062 schema-only admission, default OFF.

No source/host decisions, signed-file changes, feed jobs, secret access or
application deployment. Never retries a partially completed migration.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path("/home/ap/www/videonews-studio")
CONTAINER = "videonews-studio-postgres-1"
MIGRATION = ROOT / "db/migrations/0062_host_reconfirmation.up.sql"
ACK_ENV = "VNS_P2_0062_OPERATOR_APPROVED"
SHA_ENV = "VNS_P2_0062_EXPECTED_SHA"
ACK = "INSTALL_EXPLICIT_HOST_RECONFIRMATION_SCHEMA_ONLY"
REFUSED = "REFUSED: P2-01 0062 schema admission unsafe; inspect state, do not retry"
SHA_PATTERN = re.compile(r"[a-f0-9]{40}\Z")
DIGEST_PATTERN = re.compile(r"[a-f0-9]{32}\Z")
PRIOR = "0061_single_owner_review_policy"
NEXT = "0062_host_reconfirmation"

BASELINE = """
SELECT (
  current_database()='videonews'
  AND current_user='vns'
  AND current_setting('is_superuser')='on'
  AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999
  AND (SELECT count(*)=61 FROM vns.schema_migrations)
  AND (SELECT max(version)= '0061_single_owner_review_policy'
       FROM vns.schema_migrations)
  AND to_regprocedure('vns.named_host_change(bigint,bigint,text,text,text)') IS NOT NULL
  AND to_regclass('vns.single_owner_review_policy') IS NOT NULL
  AND (SELECT count(*)=1 FROM vns.single_owner_review_policy
       WHERE singleton AND enabled)
  AND (SELECT revision=10
       AND jsonb_array_length(sources)=3
       AND (SELECT count(*)=3
            FROM jsonb_array_elements(sources) source
            WHERE source->>'status'='approved')
       FROM vns.admin_source_registry WHERE singleton)
  AND (SELECT revision=7 AND jsonb_array_length(approved_hosts)=3
       AND approved_hosts ?& ARRAY['www.nasa.gov','www.noaa.gov','www.usgs.gov']
       FROM vns.admin_source_host_approvals WHERE singleton)
  AND (SELECT count(*)=10 FROM vns.admin_source_audit)
  AND (SELECT count(*)=7 FROM vns.admin_source_host_audit)
  AND NOT EXISTS (
    SELECT 1
    FROM vns.admin_source_host_approvals h
    CROSS JOIN LATERAL jsonb_array_elements_text(h.approved_hosts) granted(host)
    LEFT JOIN LATERAL (
      SELECT action,source_revision FROM vns.admin_source_host_audit
      WHERE host=granted.host ORDER BY revision DESC LIMIT 1
    ) a ON true
    WHERE h.singleton AND (a.action IS DISTINCT FROM 'grant'
      OR a.source_revision IS DISTINCT FROM 8)
  )
  AND (SELECT source_revision=8 AND host_approval_revision=7
       FROM vns_source_anchor.high_water WHERE anchor_id='source-export')
  AND (SELECT count(*)=0 FROM vns.feed_event_rankings
       WHERE approved_for_publication)
);
""".strip()

STATE = """
SELECT md5(
  (SELECT row_to_json(r)::text FROM vns.admin_source_registry r WHERE singleton)
  || '|'
  || (SELECT row_to_json(h)::text FROM vns.admin_source_host_approvals h WHERE singleton)
  || '|'
  || (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY revision)::text,'[]')
      FROM vns.admin_source_audit a)
  || '|'
  || (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY revision)::text,'[]')
      FROM vns.admin_source_host_audit a)
  || '|'
  || (SELECT row_to_json(a)::text FROM vns_source_anchor.high_water a
      WHERE anchor_id='source-export')
);
""".strip()

STATUS = """
SELECT (
  to_regprocedure('vns.named_host_change(bigint,bigint,text,text,text)') IS NOT NULL
  AND to_regclass('vns.single_owner_review_policy') IS NOT NULL
  AND NOT has_table_privilege('vns_p2_named_client',
    'vns.admin_source_host_approvals','UPDATE')
  AND NOT has_table_privilege('vns_p2_named_client',
    'vns.admin_source_host_audit','INSERT')
  AND NOT has_table_privilege('vns_p2_named_client',
    'vns.single_owner_review_policy','UPDATE')
  AND has_function_privilege('vns_p2_named_client',
    'vns.named_host_change(bigint,bigint,text,text,text)','EXECUTE')
);
""".strip()


def command(args: list[str], data: str | None = None, timeout: int = 40) -> str:
    try:
        result = subprocess.run(args, input=data, text=True, capture_output=True,
                                timeout=timeout, check=False)
        if result.returncode != 0 or len(result.stdout) > 8192:
            raise RuntimeError(REFUSED)
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None


def git_sha() -> str:
    if os.geteuid() != 1000:
        raise RuntimeError(REFUSED)
    git = ["git", "-C", str(ROOT)]
    if (command(git + ["branch", "--show-current"]) != "main"
            or command(git + ["status", "--porcelain"]) != ""):
        raise RuntimeError(REFUSED)
    return command(git + ["rev-parse", "HEAD"])


def psql(sql: str, write: bool = False) -> str:
    opts = "-c lock_timeout=3000 -c statement_timeout=45000"
    opts += " -c default_transaction_read_only=off" if write else (
        " -c default_transaction_read_only=on"
    )
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + opts, CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews",
    ], data=sql + "\n", timeout=55)


def before() -> None:
    container = command(["docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', CONTAINER])
    if container != "videonews-studio|postgres|healthy":
        raise RuntimeError(REFUSED)
    blocked = {"source-publisher","source-handoff-import","feed-observer",
       "feed-scheduler","feed-producer","feed-producer-continuous",
       "feed-consumer","feed-project-once","feed-project-continuous"}
    running = command([
        "docker", "ps", "-a", "--filter",
        "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}'
    ]).splitlines()
    if blocked.intersection(running):
        raise RuntimeError(REFUSED)


def migration() -> str:
    info = MIGRATION.lstat()
    if (MIGRATION.is_symlink() or not stat.S_ISREG(info.st_mode)
            or not 200 <= info.st_size <= 12000):
        raise RuntimeError(REFUSED)
    sql = MIGRATION.read_text("utf8")
    if (sql.count("\nBEGIN;") != 1 or sql.count("\nCOMMIT;") != 1
            or not sql.rstrip().endswith("COMMIT;")
            or "INSERT INTO vns.schema_migrations(version) VALUES('0062_host_reconfirmation');"
            not in sql):
        raise RuntimeError(REFUSED)
    return sql


def ledger() -> list[str]:
    return psql("SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


def main(argv: list[str]) -> None:
    p = argparse.ArgumentParser(description="P2 exact audited host schema upgrade")
    mode = p.add_mutually_exclusive_group(required=True)
    for flag in ("status","preflight","apply"):
        mode.add_argument("--" + flag, action="store_true")
    p.add_argument("--expected-sha", required=True)
    args = p.parse_args(argv)
    sha = git_sha()
    if not SHA_PATTERN.fullmatch(args.expected_sha) or args.expected_sha != sha:
        raise RuntimeError(REFUSED)
    before()
    migration()
    existing = ledger()
    if args.status:
        if len(existing) not in (61,62) or existing[-1] not in (PRIOR,NEXT):
            raise RuntimeError(REFUSED)
        if (len(existing) == 61 and existing[-1] != PRIOR
                or len(existing) == 62 and existing[-1] != NEXT
                or psql(STATUS) != "t"):
            raise RuntimeError(REFUSED)
        print("PASS: schema", "0062" if len(existing) == 62 else "0061",
              "personal host privileges verified")
        return
    if len(existing) != 61 or existing[-1] != PRIOR or psql(BASELINE) != "t":
        raise RuntimeError(REFUSED)
    digest = psql(STATE)
    if not DIGEST_PATTERN.fullmatch(digest) or psql(STATUS) != "t":
        raise RuntimeError(REFUSED)
    if args.preflight:
        print("PASS: exact source 10/host 7, stale audits bound to 8, anchor 8/7")
        print("INFO: read-only, no renewal performed")
        return
    if (os.environ.get(ACK_ENV) != ACK or
            os.environ.get(SHA_ENV) != sha):
        raise RuntimeError(REFUSED)
    if ledger() != existing or psql(STATE) != digest or psql(BASELINE) != "t":
        raise RuntimeError(REFUSED)
    psql(migration(), write=True)
    after = ledger()
    if (len(after) != 62 or after[-1] != NEXT or
            psql(STATUS) != "t" or psql(STATE) != digest):
        raise RuntimeError(REFUSED)
    print("PASS: 0062 installed; source and host audits unchanged")
    print("INFO: admin deployment and three personal host reviews remain separate")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, PermissionError,
            UnicodeError, subprocess.TimeoutExpired):
        raise SystemExit(REFUSED)
