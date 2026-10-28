#!/usr/bin/env python3
"""P1-09: guarded 0043 -> 0048 additive schema upgrade, never a generic migrator.

--status/--preflight: read-only; --apply: exact SHA and operator approval.
No automatic retry, rollback, secrets, Redis, container restart or paid call.
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
CI_PROJECT = "vns-p109-0048-ci"
FAIL = "REFUSED: controlled 0043-to-0048 migration prerequisites not met"
APPROVAL = "VNS_P109_0048_OPERATOR_APPROVED"
SHA_APPROVAL = "VNS_P109_0048_EXPECTED_MAIN_SHA"
BASE = 43
TARGET = 48
FIRST = "0044_named_provider_job_authorization"
LAST = "0048_provider_outbox_delivery_receipt"


def ci_fixture() -> bool:
    override = os.getenv("VNS_P109_0048_CI_PROJECT")
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
        argv, input=stdin, capture_output=True, text=True, check=False, timeout=timeout
    )
    if result.returncode:
        # Never print raw SQL error text: server state could include private data.
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
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError(FAIL)
    return sha


def container_name(ci: bool) -> str:
    project = CI_PROJECT if ci else PROJECT
    name = project + "-postgres-1"
    actual = command([
        "docker", "inspect", "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', name,
    ])
    if actual != project + "|postgres|healthy":
        raise RuntimeError(FAIL)
    return name


def query(container: str, sql: str, *, readonly: bool = True, timeout: int = 40) -> str:
    opts = "-c lock_timeout=4s -c statement_timeout=30s"
    if readonly:
        opts += " -c default_transaction_read_only=on"
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + opts,
        container, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], stdin=sql, timeout=timeout)


def expected_versions() -> list[str]:
    paths = sorted(MIGRATIONS.glob("*.up.sql"))
    names = [p.name.removesuffix(".up.sql") for p in paths]
    if (
        len(names) != TARGET
        or [int(n[:4]) for n in names] != list(range(1, TARGET + 1))
        or not all(re.fullmatch(r"[0-9]{4}_[a-z][a-z0-9_]{2,90}", n) for n in names)
        or names[42] != "0043_claimed_provider_secret_scope"
        or names[43] != FIRST
        or names[-1] != LAST
    ):
        raise RuntimeError(FAIL)
    for path in paths[BASE:]:
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size < 100:
            raise RuntimeError(FAIL)
        sql = path.read_text(encoding="utf8")
        if not sql.lstrip().startswith("--") or "BEGIN;" not in sql or not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
    return names


def ledger(container: str) -> list[str]:
    return query(container, "SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


SAFETY_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('is_superuser') || '|' ||
 current_setting('server_version_num') || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN (
   'vns_provider_outbox_executor','vns_provider_outbox_reader',
   'vns_provider_outbox_login')) || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL OR
   (type='host' AND auth_method='trust'
    AND coalesce(address,'') NOT IN ('127.0.0.1','::1')));
"""


ABSENCE_SQL = """
SELECT
 to_regclass('vns.provider_named_job_authorizations') IS NULL AND
 to_regclass('vns.provider_named_job_outbox') IS NULL AND
 to_regclass('vns.provider_named_job_sealed_prompts') IS NULL AND
 to_regclass('vns.provider_named_job_delivery_receipts') IS NULL AND
 to_regprocedure('vns.read_authorized_provider_outbox(integer)') IS NULL;
"""


def resources(ci: bool) -> None:
    if ci:
        return
    space = os.statvfs(ROOT)
    if space.f_bavail * space.f_frsize < 15 * 1024 ** 3:
        raise RuntimeError(FAIL)
    available = 0
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            available = int(line.split()[1]) * 1024
    if available < 1800 * 1024 ** 2:
        raise RuntimeError(FAIL)


def preflight(container: str, versions: list[str], ci: bool) -> None:
    if ledger(container) != versions[:BASE]:
        raise RuntimeError(FAIL)
    state = query(container, SAFETY_SQL).split("|")
    if (
        len(state) != 9
        or state[:3] != ["vns", "videonews", "on"]
        or not re.fullmatch(r"17[0-9]{4}", state[3])
        or state[4:] != ["0", "0", "0", "0", "0"]
        or query(container, ABSENCE_SQL) != "t"
    ):
        raise RuntimeError(FAIL)
    resources(ci)


def final_check(container: str, versions: list[str]) -> None:
    if ledger(container) != versions:
        raise RuntimeError(FAIL)
    results = query(container, """
SELECT
  (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
  (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled) || '|' ||
  (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled) || '|' ||
  (SELECT count(*) FROM pg_roles WHERE rolname IN
   ('vns_provider_outbox_executor','vns_provider_outbox_reader')
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
   AND NOT rolcreatedb AND NOT rolreplication) || '|' ||
  (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_outbox_login') || '|' ||
  (SELECT count(*) FROM vns.provider_named_job_delivery_receipts) || '|' ||
  has_function_privilege('vns_provider_outbox_reader',
    'vns.read_authorized_provider_outbox(integer)','EXECUTE') || '|' ||
  has_function_privilege('vns_provider_outbox_reader',
    'vns.ack_provider_outbox_delivery(uuid)','EXECUTE') || '|' ||
  has_table_privilege('vns_provider_outbox_reader',
    'vns.provider_named_job_sealed_prompts','SELECT');
""")
    if results != "0|0|0|2|0|0|t|t|f":
        if ci_fixture():
            print("CI-only synthetic 0048 non-secret final flags: " + results)
        raise RuntimeError(FAIL)


def apply(container: str, versions: list[str]) -> None:
    # Every file has its own BEGIN/COMMIT. An ambiguous result stops all work;
    # NEVER attempt rollback or retry an uncertain database transaction.
    for index in range(BASE, TARGET):
        if ledger(container) != versions[:index]:
            raise RuntimeError(FAIL)
        name = versions[index]
        path = MIGRATIONS / (name + ".up.sql")
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(FAIL)
        sql = path.read_text(encoding="utf8")
        if not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
        query(container, sql, readonly=False, timeout=140)
        if ledger(container) != versions[:index + 1]:
            raise RuntimeError(FAIL)
        print("PASS: applied " + name)
    final_check(container, versions)


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"]):
        raise ValueError(FAIL)
    ci = ci_fixture()
    sha = git_state(ci)
    container = container_name(ci)
    versions = expected_versions()
    if args == ["--status"]:
        current = ledger(container)
        if current != versions[:len(current)] or not BASE <= len(current) <= TARGET:
            raise RuntimeError(FAIL)
        print("PASS: exact schema prefix through " + current[-1])
    elif args == ["--preflight"]:
        preflight(container, versions, ci)
        print("PASS: schema 0043, provider/budgets disabled, no 0044–0048 objects")
    else:
        if os.getenv(APPROVAL) != "APPLY_ADDITIVE_0044_0048":
            raise RuntimeError(FAIL)
        if not ci and os.getenv(SHA_APPROVAL) != sha:
            raise RuntimeError(FAIL)
        preflight(container, versions, ci)
        apply(container, versions)
        print("PASS: schema 0048 installed, outbox remains unprovisioned and disabled")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, PermissionError, UnicodeError,
            subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
