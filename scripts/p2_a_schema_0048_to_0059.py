#!/usr/bin/env python3
"""P2-A: exact, additive 0048 -> 0059 PostgreSQL upgrade; no runtime activation.

--status/--preflight use read-only SQL. --apply requires an independently
approved exact Git SHA and an explicit scoped operator ACK. Never retries,
rolls back, sets up passwords, starts services, or approves sources.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"
PROJECT = "videonews-studio"
CONTAINER = PROJECT + "-postgres-1"
BASE = 48
TARGET = 59
FIRST = "0049_approved_feed_rankings"
LAST = "0059_canonical_event_title_fingerprint"
FAIL = "REFUSED: P2-A controlled 0048-to-0059 schema prerequisites not met"
APPROVAL = "VNS_P2_A_0059_OPERATOR_APPROVED"
SHA_APPROVAL = "VNS_P2_A_0059_EXPECTED_MAIN_SHA"
SHA = re.compile(r"^[a-f0-9]{40}$")
VERSION = re.compile(r"^[0-9]{4}_[a-z][a-z0-9_]{2,90}$")


def command(args: list[str], *, stdin: str | None = None, timeout: int = 40) -> str:
    result = subprocess.run(
        args, input=stdin, capture_output=True, text=True,
        check=False, timeout=timeout,
    )
    # Raw SQL errors may contain private article, audit or credential data.
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def git_sha() -> str:
    if os.geteuid() != 1000:
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    sha = command(["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD"])
    if not SHA.fullmatch(sha):
        raise RuntimeError(FAIL)
    return sha


def container() -> str:
    result = command([
        "docker", "inspect", "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        CONTAINER,
    ])
    if result != PROJECT + "|postgres|healthy":
        raise RuntimeError(FAIL)
    return CONTAINER


def query(name: str, sql: str, *, readonly: bool = True, timeout: int = 40) -> str:
    if name != CONTAINER or not isinstance(sql, str):
        raise RuntimeError(FAIL)
    opts = "-c lock_timeout=3s -c statement_timeout=60000"
    if readonly:
        opts += " -c default_transaction_read_only=on"
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + opts,
        name, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], stdin=sql + "\n", timeout=timeout)


def expected_versions() -> list[str]:
    paths = sorted(MIGRATIONS.glob("*.up.sql"))
    names = [p.name.removesuffix(".up.sql") for p in paths]
    if (
        len(names) != TARGET
        or [name[:4] for name in names] != [f"{n:04d}" for n in range(1, TARGET + 1)]
        or not all(VERSION.fullmatch(name) for name in names)
        or names[BASE] != FIRST
        or names[-1] != LAST
    ):
        raise RuntimeError(FAIL)
    for path in paths[BASE:]:
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or not 100 <= info.st_size <= 100000:
            raise RuntimeError(FAIL)
        sql = path.read_text(encoding="utf-8")
        if not sql.lstrip().startswith("--") or "BEGIN;" not in sql or not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
    return names


def ledger(name: str) -> list[str]:
    return query(name, "SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


SAFETY_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('is_superuser') || '|' ||
 current_setting('server_version_num') || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL OR
   (type='host' AND auth_method='trust' AND
    coalesce(address,'') NOT IN ('127.0.0.1','::1'))) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled);
""".strip()

ABSENCE_SQL = """
SELECT
 to_regclass('vns.feed_event_rankings') IS NULL AND
 to_regclass('vns.feed_ranking_policy_reviews') IS NULL AND
 to_regclass('vns.feed_publisher_provenance_reviews') IS NULL AND
 to_regclass('vns.feed_event_factor_reviews') IS NULL AND
 to_regprocedure('vns.rank_nfkc_words(text)') IS NULL AND
 to_regprocedure('vns.named_ranking_policy_commit(text,bigint,jsonb)') IS NULL;
""".strip()

# Hash only existing owner-maintained configuration and governance snapshots.
# The hash is compared in memory, never printed.
UNCHANGED_SQL = """
SELECT
 (SELECT revision::text || ':' || md5(sources::text)
  FROM vns.admin_source_registry WHERE singleton=true) || '|' ||
 (SELECT revision::text || ':' || md5(approved_hosts::text)
  FROM vns.admin_source_host_approvals WHERE singleton=true) || '|' ||
 (SELECT revision::text || ':' || md5(profiles::text)
  FROM vns.editorial_profile_registry WHERE singleton=true);
""".strip()

FINAL_SQL = """
SELECT
 (SELECT count(*) FROM vns.feed_event_rankings) || '|' ||
 (SELECT count(*) FROM vns.feed_ranking_policy_reviews) || '|' ||
 (SELECT count(*) FROM vns.feed_publisher_provenance_reviews) || '|' ||
 (SELECT count(*) FROM vns.feed_event_factor_reviews) || '|' ||
 has_function_privilege('vns_feed_project_client',
   'vns.project_approved_feed_candidates(text,integer)','EXECUTE') || '|' ||
 has_table_privilege('vns_p2_named_client',
   'vns.feed_event_rankings','SELECT') || '|' ||
 has_function_privilege('vns_p2_named_client',
   'vns.named_ranked_feed_page(integer)','EXECUTE');
""".strip()


def resources() -> None:
    space = os.statvfs(ROOT)
    if space.f_bavail * space.f_frsize < 5 * 1024**3:
        raise RuntimeError(FAIL)
    memory = 0
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            memory = int(line.split()[1]) * 1024
    if memory < 1024**3:
        raise RuntimeError(FAIL)


def preflight(name: str, names: list[str]) -> str:
    if ledger(name) != names[:BASE]:
        raise RuntimeError(FAIL)
    state = query(name, SAFETY_SQL).split("|")
    if (
        len(state) != 8
        or state[:3] != ["vns", "videonews", "on"]
        or not re.fullmatch(r"17[0-9]{4}", state[3])
        or state[4] != "0"
        or state[5:] != ["0", "0", "0"]
        or query(name, ABSENCE_SQL) != "t"
    ):
        raise RuntimeError(FAIL)
    fingerprint = query(name, UNCHANGED_SQL)
    if not re.fullmatch(r"[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}", fingerprint):
        raise RuntimeError(FAIL)
    resources()
    return fingerprint


def final_check(name: str, names: list[str], snapshot: str) -> None:
    if ledger(name) != names or query(name, UNCHANGED_SQL) != snapshot:
        raise RuntimeError(FAIL)
    # Schema installation does not grant feed approval, create editorial
    # reviews or publish news; nor does it expose raw ranking tables.
    if query(name, FINAL_SQL) != "0|0|0|0|true|false|true":
        raise RuntimeError(FAIL)
    state = query(name, SAFETY_SQL).split("|")
    if len(state) != 8 or state[5:] != ["0", "0", "0"]:
        raise RuntimeError(FAIL)


def apply(name: str, names: list[str], snapshot: str) -> None:
    # Exactly one migration transaction at a time; never auto-resume,
    # auto-retry or run destructive .down.sql against production.
    for index in range(BASE, TARGET):
        if ledger(name) != names[:index]:
            raise RuntimeError(FAIL)
        path = MIGRATIONS / (names[index] + ".up.sql")
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(FAIL)
        sql = path.read_text(encoding="utf-8")
        if not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
        query(name, sql, readonly=False, timeout=140)
        if ledger(name) != names[:index + 1]:
            raise RuntimeError(FAIL)
        print("PASS: applied " + names[index])
    final_check(name, names, snapshot)


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"]):
        raise RuntimeError(FAIL)
    sha = git_sha()
    names = expected_versions()
    if args == ["--apply"]:
        if (
            os.getenv(APPROVAL) != "APPLY_ADDITIVE_0049_0059"
            or os.getenv(SHA_APPROVAL) != sha
        ):
            raise RuntimeError(FAIL)
    name = container()
    if args == ["--status"]:
        existing = ledger(name)
        if not BASE <= len(existing) <= TARGET or existing != names[:len(existing)]:
            raise RuntimeError(FAIL)
        print("PASS: exact installed schema prefix through " + existing[-1])
    elif args == ["--preflight"]:
        preflight(name, names)
        print("PASS: exact P1-0048 baseline; P2 schema 0049-0059 may be reviewed for rollout")
        print("INFO: no source approval, service activation or production acceptance performed")
    else:
        state = preflight(name, names)
        apply(name, names, state)
        print("PASS: exact schema 0059; no source, ranking or publication activation")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, PermissionError, UnicodeError,
            subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
