#!/usr/bin/env python3
"""P2-01 controlled schema-only 0059 -> 0061 admission, default OFF.

No source or host policy activation, external network, image rollout or
automatic rollback. Errors are redacted. Operator must separately authorize
the exact GitHub commit and schema-only scope before applying migrations.
"""

from __future__ import annotations

import os
import re
import stat
import sys

import p2_a_schema_0048_to_0059 as prior

ROOT = prior.ROOT
MIGRATIONS = prior.MIGRATIONS
CONTAINER = prior.CONTAINER
FAIL = "REFUSED: controlled P2-01 0059-to-0061 schema gate not satisfied"
ACK = "VNS_P2_0061_APPLY_APPROVED"
SHA_ACK = "VNS_P2_0061_EXPECTED_MAIN_SHA"
NEW = (
    "0060_named_source_host_admin_gateways",
    "0061_single_owner_review_policy",
)

BASELINE_SQL = """
SELECT
  to_regprocedure('vns.named_source_read()') IS NULL
  AND to_regprocedure('vns.named_host_change(bigint,bigint,text,text,text)') IS NULL
  AND to_regclass('vns.single_owner_review_policy') IS NULL;
""".strip()

# Require an entirely unused source/host grant registry before provisioning.
# Nothing here asserts that any real publisher license has been reviewed.
INACTIVE_SQL = """
SELECT
  (SELECT count(*) FROM vns.admin_source_registry
   WHERE singleton=true AND sources='[]'::jsonb AND revision=0)=1
  AND (SELECT count(*) FROM vns.admin_source_host_approvals
   WHERE singleton=true AND approved_hosts='[]'::jsonb AND revision=0)=1
  AND (SELECT count(*) FROM vns.admin_source_audit)=0
  AND (SELECT count(*) FROM vns.admin_source_host_audit)=0
  AND (SELECT count(*) FROM vns.feed_event_rankings
   WHERE approved_for_publication)=0;
""".strip()

FINAL_SQL = """
SELECT
  (SELECT NOT enabled AND owner_editor_id IS NULL
    AND authorized_at IS NULL
    FROM vns.single_owner_review_policy WHERE singleton=true)
  AND to_regprocedure('vns.named_source_read()') IS NOT NULL
  AND to_regprocedure('vns.named_host_change(bigint,bigint,text,text,text)') IS NOT NULL
  AND has_function_privilege(
    'vns_p2_named_client','vns.named_source_read()','EXECUTE')
  AND has_function_privilege(
    'vns_p2_named_client',
    'vns.named_host_change(bigint,bigint,text,text,text)','EXECUTE')
  AND NOT has_function_privilege(
    'vns_api_runtime',
    'vns.named_source_commit(bigint,bigint,jsonb,text,text)','EXECUTE')
  AND NOT has_table_privilege(
    'vns_p2_named_client','vns.admin_source_registry','UPDATE')
  AND NOT has_table_privilege(
    'vns_p2_named_client','vns.single_owner_review_policy','UPDATE')
  AND (SELECT count(*) FROM vns.admin_source_host_audit
       WHERE approval_model NOT IN ('two_person','single_owner'))=0;
""".strip()


def expected_versions() -> list[str]:
    """Confirm the 61-file checked-out manifest (including new SQL)."""
    names = [path.name.removesuffix(".up.sql")
             for path in sorted(MIGRATIONS.glob("*.up.sql"))]
    if len(names) != 61 or names[-2:] != list(NEW):
        raise RuntimeError(FAIL)
    if names[:59] != prior.expected_versions():
        raise RuntimeError(FAIL)
    for name in NEW:
        path = MIGRATIONS / (name + ".up.sql")
        info = path.lstat()
        if (path.is_symlink() or not stat.S_ISREG(info.st_mode)
                or not 100 <= info.st_size <= 100000):
            raise RuntimeError(FAIL)
        sql = path.read_text(encoding="utf-8")
        if not sql.lstrip().startswith("--") or "BEGIN;" not in sql or not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
    return names


def sql(text: str, *, readonly: bool = True, timeout: int = 40) -> str:
    # Do not expose SQL error output or private DB metadata.
    try:
        return prior.query(CONTAINER, text, readonly=readonly, timeout=timeout)
    except (OSError, RuntimeError, ValueError):
        raise RuntimeError(FAIL) from None


def ledger() -> list[str]:
    return sql("SELECT version FROM vns.schema_migrations ORDER BY version;").splitlines()


def check_safety() -> None:
    state = sql(prior.SAFETY_SQL).split("|")
    if (
        len(state) != 8
        or state[:3] != ["vns", "videonews", "on"]
        or re.fullmatch(r"17[0-9]{4}", state[3]) is None
        or state[4:] != ["0", "0", "0", "0"]
    ):
        raise RuntimeError(FAIL)
    prior.resources()


def preflight(names: list[str]) -> str:
    if ledger() != names[:59]:
        raise RuntimeError(FAIL)
    check_safety()
    if sql(BASELINE_SQL) != "t" or sql(INACTIVE_SQL) != "t":
        raise RuntimeError(FAIL)
    snapshot = sql(prior.UNCHANGED_SQL)
    if not re.fullmatch(
        r"[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}",
        snapshot,
    ):
        raise RuntimeError(FAIL)
    return snapshot


def final_check(names: list[str], snapshot: str) -> None:
    if ledger() != names or sql(prior.UNCHANGED_SQL) != snapshot:
        raise RuntimeError(FAIL)
    if sql(INACTIVE_SQL) != "t" or sql(FINAL_SQL) != "t":
        raise RuntimeError(FAIL)
    check_safety()


def apply(names: list[str], snapshot: str) -> None:
    # Only forward additive transactions; no retries, .down.sql, or restarts.
    for idx in (59, 60):
        if ledger() != names[:idx]:
            raise RuntimeError(FAIL)
        path = MIGRATIONS / (names[idx] + ".up.sql")
        sql_text = path.read_text(encoding="utf-8")
        if not sql_text.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
        sql(sql_text, readonly=False, timeout=140)
        if ledger() != names[:idx+1]:
            raise RuntimeError(FAIL)
        print("PASS: applied " + names[idx], flush=True)
    final_check(names, snapshot)


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"]):
        raise RuntimeError(FAIL)
    sha = prior.git_sha()
    names = expected_versions()
    if args == ["--apply"] and (
        os.getenv(ACK) != "INSTALL_SCHEMA_ONLY_0060_0061"
        or os.getenv(SHA_ACK) != sha
    ):
        raise RuntimeError(FAIL)
    prior.container()
    if args == ["--status"]:
        existing = ledger()
        if len(existing) not in (59, 60, 61) or existing != names[:len(existing)]:
            raise RuntimeError(FAIL)
        if len(existing) == 60:
            print("BLOCKED: partial 0060 installation; do not auto-resume")
        elif len(existing) == 59:
            print("PASS: exact installed schema 0059, 0060/0061 absent")
        else:
            final_check(names, sql(prior.UNCHANGED_SQL))
            print("PASS: schema 0061 installed, owner mode and sources disabled")
        return
    if args == ["--preflight"]:
        preflight(names)
        print("PASS: additive 0060/0061 schema-only rollout prerequisites")
        print("INFO: no source, owner-policy, host or feed activation")
        return
    snapshot = preflight(names)
    apply(names, snapshot)
    print("PASS: schema 0061 installed with single-owner mode default OFF")
    print("INFO: neither API nor sources were activated")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, PermissionError,
            UnicodeError, OverflowError):
        raise SystemExit(FAIL)
