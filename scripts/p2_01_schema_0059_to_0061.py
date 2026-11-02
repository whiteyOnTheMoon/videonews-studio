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
REVIEWED_ACK = "VNS_P2_0061_REVIEWED_STATE_APPROVED"
REVIEWED_ACK_VALUE = "PRESERVE_EXISTING_REVIEWED_SOURCE_AND_HOST_REGISTERS"
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

# Additive schema changes on a VPS may follow already audited source/host
# revisions. Such state must be preserved, never silently reset to empty.
# This check proves only structural/audit consistency, NOT legal feed rights.
REVIEWED_STATE_SQL = """
SELECT
  (SELECT revision>0 AND jsonb_array_length(sources) BETWEEN 3 AND 5
     AND (SELECT count(*) FROM jsonb_array_elements(sources) AS s(value)
          WHERE s.value->>'status'='approved') BETWEEN 3 AND 5
     FROM vns.admin_source_registry WHERE singleton=true)
  AND
  (SELECT revision>0 AND jsonb_array_length(approved_hosts) BETWEEN 1 AND 5
     FROM vns.admin_source_host_approvals WHERE singleton=true)
  -- Audit ledger must be consecutive: rev=8 means exactly 1..8 and no
  -- unrecorded historical transition, not merely 'some' audit rows.
  AND (SELECT count(*)=r.revision AND min(a.revision)=1
              AND max(a.revision)=r.revision
       FROM vns.admin_source_audit a CROSS JOIN vns.admin_source_registry r
       WHERE r.singleton=true)
  AND (SELECT count(*)=h.revision AND min(a.revision)=1
              AND max(a.revision)=h.revision
       FROM vns.admin_source_host_audit a
       CROSS JOIN vns.admin_source_host_approvals h
       WHERE h.singleton=true)
  -- Every currently approved source must end in a personally audited
  -- approval, even if earlier events were pending/replaced.
  AND NOT EXISTS (
    SELECT 1 FROM vns.admin_source_registry r
    CROSS JOIN LATERAL jsonb_array_elements(r.sources) AS item(value)
    WHERE r.singleton=true AND item.value->>'status'='approved'
      AND coalesce((
        SELECT a.action FROM vns.admin_source_audit a
        WHERE a.source_id=item.value->>'id'
        ORDER BY a.revision DESC LIMIT 1
      ),'')<>'approve'
  )
  -- Every approved host must have a current grant audit and an approved
  -- source at that exact host. This check does not grant any rights.
  AND NOT EXISTS (
    SELECT 1 FROM vns.admin_source_host_approvals h
    CROSS JOIN LATERAL jsonb_array_elements_text(h.approved_hosts)
      AS approved(host)
    WHERE h.singleton=true AND (
      coalesce((
        SELECT a.action FROM vns.admin_source_host_audit a
        WHERE a.host=approved.host ORDER BY a.revision DESC LIMIT 1
      ),'')<>'grant'
      OR NOT EXISTS (
        SELECT 1 FROM vns.admin_source_registry r
        CROSS JOIN LATERAL jsonb_array_elements(r.sources) AS item(value)
        WHERE r.singleton=true AND item.value->>'status'='approved'
          AND split_part(
            split_part(item.value->>'baseUrl','https://',2), '/',1
          )=approved.host
      )
    )
  )
  AND (SELECT count(*)=0 FROM vns.feed_event_rankings
       WHERE approved_for_publication);
""".strip()

# Only aggregate row counts and digests are ever seen by the operator tool.
# The new approval_model column added by 0061 must be excluded from both
# sides of this comparison to avoid a false-positive historical audit drift.
REVIEWED_AUDIT_SNAPSHOT_SQL = """
SELECT
  (SELECT count(*)::text || ':' ||
    md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY revision)::text,'[]'))
   FROM vns.admin_source_audit AS a)
  || '|' ||
  (SELECT count(*)::text || ':' ||
    md5(coalesce(jsonb_agg(to_jsonb(a)-'approval_model'
                           ORDER BY revision)::text,'[]'))
   FROM vns.admin_source_host_audit AS a);
""".strip()

STATUS_SQL = """
SELECT to_regprocedure('vns.named_source_read()') IS NOT NULL
  AND to_regprocedure('vns.named_host_change(bigint,bigint,text,text,text)') IS NOT NULL
  AND (SELECT count(*) FROM vns.single_owner_review_policy
       WHERE singleton=true)=1;
""".strip()

REQUIRED_ROLES_SQL = """
SELECT to_regrole('vns_p2_named_client') IS NOT NULL
  AND to_regrole('vns_p2_named_executor') IS NOT NULL
  AND to_regrole('vns_host_approval_executor') IS NOT NULL;
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
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles AS role
    WHERE role.rolname='vns_api_runtime'
      AND has_function_privilege(
        role.oid,
        'vns.named_source_commit(bigint,bigint,jsonb,text,text)','EXECUTE')
  )
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


def preflight(names: list[str], *, reviewed_state: bool = False) -> str:
    if ledger() != names[:59]:
        raise RuntimeError(FAIL)
    check_safety()
    # Missing schema prerequisite roles must fail BEFORE any migration.
    if sql(REQUIRED_ROLES_SQL) != "t":
        raise RuntimeError(FAIL)
    state_sql = REVIEWED_STATE_SQL if reviewed_state else INACTIVE_SQL
    if sql(BASELINE_SQL) != "t" or sql(state_sql) != "t":
        raise RuntimeError(FAIL)
    snapshot = sql(prior.UNCHANGED_SQL)
    if not re.fullmatch(
        r"[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}\|[0-9]{1,16}:[a-f0-9]{32}",
        snapshot,
    ):
        raise RuntimeError(FAIL)
    return snapshot


def final_check(names: list[str], snapshot: str, *, reviewed_state: bool = False,
                audit_snapshot: str | None = None) -> None:
    if ledger() != names or sql(prior.UNCHANGED_SQL) != snapshot:
        raise RuntimeError(FAIL)
    state_sql = REVIEWED_STATE_SQL if reviewed_state else INACTIVE_SQL
    if sql(state_sql) != "t" or sql(FINAL_SQL) != "t":
        raise RuntimeError(FAIL)
    if reviewed_state and (audit_snapshot is None or
            sql(REVIEWED_AUDIT_SNAPSHOT_SQL) != audit_snapshot):
        raise RuntimeError(FAIL)
    if sql(REQUIRED_ROLES_SQL) != "t":
        raise RuntimeError(FAIL)
    check_safety()


def apply(names: list[str], snapshot: str, *, reviewed_state: bool = False,
          audit_snapshot: str | None = None) -> None:
    # Only forward additive transactions; no retries, .down.sql, or restarts.
    for idx in (59, 60):
        if ledger() != names[:idx]:
            raise RuntimeError(FAIL)
        if reviewed_state:
            # Halt before the next irreversible schema transaction if source,
            # host, profile or historical audits changed since preflight.
            if (sql(prior.UNCHANGED_SQL) != snapshot
                    or audit_snapshot is None
                    or sql(REVIEWED_AUDIT_SNAPSHOT_SQL) != audit_snapshot
                    or sql(REVIEWED_STATE_SQL) != "t"):
                raise RuntimeError(FAIL)
        path = MIGRATIONS / (names[idx] + ".up.sql")
        sql_text = path.read_text(encoding="utf-8")
        if not sql_text.rstrip().endswith("COMMIT;"):
            raise RuntimeError(FAIL)
        sql(sql_text, readonly=False, timeout=140)
        if ledger() != names[:idx+1]:
            raise RuntimeError(FAIL)
        print("PASS: applied " + names[idx], flush=True)
    if reviewed_state:
        final_check(names, snapshot, reviewed_state=True,
                    audit_snapshot=audit_snapshot)
    else:
        final_check(names, snapshot)


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"],
                    ["--preflight-reviewed"], ["--apply-reviewed"]):
        raise RuntimeError(FAIL)
    sha = prior.git_sha()
    names = expected_versions()
    if args == ["--apply"] and (
        os.getenv(ACK) != "INSTALL_SCHEMA_ONLY_0060_0061"
        or os.getenv(SHA_ACK) != sha
    ):
        raise RuntimeError(FAIL)
    if args == ["--apply-reviewed"] and (
        os.getenv(ACK) != "INSTALL_SCHEMA_ONLY_0060_0061"
        or os.getenv(SHA_ACK) != sha
        or os.getenv(REVIEWED_ACK) != REVIEWED_ACK_VALUE
    ):
        raise RuntimeError(FAIL)
    prior.container()
    if args == ["--status"]:
        existing = ledger()
        if len(existing) not in (59, 60, 61) or existing != names[:len(existing)]:
            raise RuntimeError(FAIL)
        if len(existing) == 60:
            raise RuntimeError(FAIL)  # Partial upgrade needs manual review.
        if len(existing) == 59:
            print("PASS: exact installed schema 0059, 0060/0061 absent")
        else:
            if sql(STATUS_SQL) != "t":
                raise RuntimeError(FAIL)
            print("PASS: exact installed schema 0061; owner policy managed separately")
        return
    if args == ["--preflight"]:
        preflight(names)
        print("PASS: additive 0060/0061 schema-only rollout prerequisites")
        print("INFO: no source, owner-policy, host or feed activation")
        return
    if args == ["--preflight-reviewed"]:
        snapshot = preflight(names, reviewed_state=True)
        audit_snapshot = sql(REVIEWED_AUDIT_SNAPSHOT_SQL)
        if not re.fullmatch(
            r"[0-9]{1,16}:[0-9a-f]{32}\|[0-9]{1,16}:[0-9a-f]{32}",
            audit_snapshot,
        ):
            raise RuntimeError(FAIL)
        print("PASS: existing reviewed source/host registers can be preserved")
        print("INFO: source rights and feed activation remain separately gated")
        return
    if args == ["--apply-reviewed"]:
        snapshot = preflight(names, reviewed_state=True)
        audit_snapshot = sql(REVIEWED_AUDIT_SNAPSHOT_SQL)
        if not re.fullmatch(
            r"[0-9]{1,16}:[0-9a-f]{32}\|[0-9]{1,16}:[0-9a-f]{32}",
            audit_snapshot,
        ):
            raise RuntimeError(FAIL)
        apply(names, snapshot, reviewed_state=True, audit_snapshot=audit_snapshot)
        print("PASS: schema 0061 installed; existing source and host audits preserved")
        print("INFO: no source review, feed activation or publication performed")
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
