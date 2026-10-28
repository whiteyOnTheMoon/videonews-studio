#!/usr/bin/env python3
"""P1-09: additive, fail-closed PostgreSQL 0018 -> 0043 upgrade helper.

Default read-only; --apply needs operator approval and an exact main SHA.
No backup creation, provider call, secret provisioning or runtime restart.
Never auto-retry a failed migration or apply .down.sql to a live database.
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
CI_PROJECT = "vns-p109-0043-ci"
FAIL = "REFUSED: controlled 0018-to-0043 migration preconditions not met"
APPROVAL = "VNS_P109_0043_OPERATOR_APPROVED"
SHA_APPROVAL = "VNS_P109_0043_EXPECTED_MAIN_SHA"


def ci_fixture() -> bool:
    override = os.getenv("VNS_P109_0043_CI_PROJECT")
    if not override:
        return False
    if (
        override != CI_PROJECT
        or os.getenv("GITHUB_ACTIONS") != "true"
        or os.getenv("CI") != "true"
        or os.getenv("GITHUB_REPOSITORY") != "whiteyOnTheMoon/videonews-studio"
        or not re.fullmatch(r"[0-9]+", os.getenv("GITHUB_RUN_ID", ""))
    ):
        raise RuntimeError(FAIL)
    return True


def command(argv: list[str], *, stdin: str | None = None, timeout: int = 40) -> str:
    result = subprocess.run(
        argv, input=stdin, text=True, capture_output=True, check=False,
        timeout=timeout,
    )
    # Never echo raw psql diagnostics: incidental DB values may be sensitive.
    if result.returncode:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def git_state(ci: bool) -> str:
    if not ci and os.geteuid() != 1000:
        raise PermissionError(FAIL)
    if not ci and command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    sha = command(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError(FAIL)
    return sha


def container_name(ci: bool) -> str:
    project = CI_PROJECT if ci else PROJECT
    name = project + "-postgres-1"
    result = command([
        "docker", "inspect", "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        name,
    ])
    if result != project + "|postgres|healthy":
        raise RuntimeError(FAIL)
    return name


def query(container: str, sql: str, *, readonly: bool = True, timeout: int = 40) -> str:
    options = "-c lock_timeout=4s -c statement_timeout=30s"
    if readonly:
        options += " -c default_transaction_read_only=on"
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + options,
        container, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], stdin=sql, timeout=timeout)


def filenames() -> list[str]:
    paths = sorted(MIGRATIONS.glob("*.up.sql"))
    names = [p.name.removesuffix(".up.sql") for p in paths]
    if (
        len(names) != 43
        or [int(name[:4]) for name in names] != list(range(1, 44))
        or not all(re.fullmatch(r"[0-9]{4}_[a-z][a-z0-9_]{2,90}", name) for name in names)
        or names[17] != "0018_ai_provider_named_audit"
        or names[-1] != "0043_claimed_provider_secret_scope"
    ):
        raise RuntimeError(FAIL)
    for path in paths:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size < 30 or path.is_symlink():
            raise RuntimeError(FAIL)
    return names


def ledger(container: str) -> list[str]:
    return query(container, "SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


TARGET_STATE_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('is_superuser') || '|' ||
 current_setting('server_version_num') || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_sealed_credentials) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN (
  'vns_provider_usage_writer','vns_provider_usage_executor',
  'vns_provider_secret_reader','vns_provider_secret_executor')) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN (
  'vns_provider_usage_login','vns_provider_secret_login')) || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL
   OR (type='host' AND auth_method='trust'
     AND COALESCE(address,'') NOT IN ('127.0.0.1','::1')));
"""


def check_resources(ci: bool) -> None:
    if ci:
        return
    disk = os.statvfs(ROOT)
    if disk.f_bavail * disk.f_frsize < 15 * 1024 ** 3:
        raise RuntimeError(FAIL)
    # The operator's VPS must have sufficient available RAM for a bounded
    # schema DDL operation; do not invoke Docker or a provider here.
    available = 0
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            available = int(line.split()[1]) * 1024
    if available < 1800 * 1024 ** 2:
        raise RuntimeError(FAIL)


def check_0018_baseline(container: str, versions: list[str], ci: bool) -> None:
    if ledger(container) != versions[:18]:
        raise RuntimeError(FAIL)
    state = query(container, TARGET_STATE_SQL).split("|")
    if (
        len(state) != 9
        or state[:3] != ["vns", "videonews", "on"]
        or not re.fullmatch(r"17[0-9]{4}", state[3])
        or state[4:] != ["0", "0", "0", "0", "0"]
    ):
        raise RuntimeError(FAIL)
    if query(container, """
SELECT to_regclass('vns.provider_live_reservations') IS NULL
  AND to_regclass('vns.provider_live_dispatch_claims') IS NULL
  AND to_regclass('vns.provider_live_credential_reads') IS NULL
  AND to_regclass('vns.provider_live_eur_policy') IS NULL;
""") != "t":
        raise RuntimeError(FAIL)
    check_resources(ci)


def final_state(container: str, versions: list[str]) -> None:
    if ledger(container) != versions:
        raise RuntimeError(FAIL)
    actual = query(container, """
SELECT
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_sealed_credentials) || '|' ||
 (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled OR halted) || '|' ||
 (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_dispatch_claims) || '|' ||
 (SELECT count(*) FROM vns.provider_live_reservations) || '|' ||
 (SELECT count(*) FROM vns.provider_live_credential_reads) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_provider_usage_writer','vns_provider_usage_executor',
  'vns_provider_secret_reader','vns_provider_secret_executor')
 AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_provider_usage_login','vns_provider_secret_login'));
""")
    if actual != "0|0|0|0|0|0|0|4|0":
        raise RuntimeError(FAIL)


def apply(container: str, versions: list[str]) -> None:
    # Every migration file already contains its own BEGIN/COMMIT.
    # A failed step may leave previous steps committed: STOP, no retry.
    for index in range(18, len(versions)):
        name = versions[index]
        if ledger(container) != versions[:index]:
            raise RuntimeError(FAIL)
        path = MIGRATIONS / (name + ".up.sql")
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(FAIL)
        content = path.read_text(encoding="utf-8")
        if not content.startswith("--") or "BEGIN;" not in content or "COMMIT;" not in content:
            raise RuntimeError(FAIL)
        query(container, content, readonly=False, timeout=140)
        if ledger(container) != versions[:index + 1]:
            raise RuntimeError(FAIL)
        print("PASS: migrated " + name)
    final_state(container, versions)


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"]):
        raise ValueError(FAIL)
    ci = ci_fixture()
    head = git_state(ci)
    container = container_name(ci)
    versions = filenames()
    if args == ["--status"]:
        current = ledger(container)
        if current not in (versions[:18], versions):
            raise RuntimeError(FAIL)
        print("PASS: detected schema " + str(len(current)).zfill(4))
    elif args == ["--preflight"]:
        check_0018_baseline(container, versions, ci)
        print("PASS: exact schema 0018, disabled provider, safe migration prerequisites")
    else:
        if os.getenv(APPROVAL) != "APPLY_ADDITIVE_0019_0043":
            raise RuntimeError(FAIL)
        if not ci and os.getenv(SHA_APPROVAL) != head:
            raise RuntimeError(FAIL)
        check_0018_baseline(container, versions, ci)
        apply(container, versions)
        print("PASS: exact schema 0043; no AI provider or budget activated")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, PermissionError,
            subprocess.TimeoutExpired, UnicodeError):
        raise SystemExit(FAIL)
