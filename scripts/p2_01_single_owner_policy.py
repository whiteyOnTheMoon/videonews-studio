#!/usr/bin/env python3
"""P2-01: one-time operator-authorized single-owner policy enrollment.

This does not create identities, approve hosts/sources, fetch feeds, change
container configuration, or publish content. A standalone DBA-only SQL change
requires exact Git SHA and explicit personal owner authorization.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

import p2_a_schema_0048_to_0059 as db

FAIL = "REFUSED: P2-01 sole-owner policy prerequisites not met"
ACK = "VNS_P2_01_SOLE_OWNER_APPROVED"
ACK_VALUE = "AUTHORIZE_PERSONAL_OWNER_ONLY"
SHA_ACK = "VNS_P2_01_SOLE_OWNER_EXPECTED_MAIN_SHA"
OWNER = "vns_owner_admin"
LOGIN = "editor_vns_owner_admin"
REASON = (
    "VideoNews Studio is operated by its sole accountable human owner. "
    "Source rights and host scope are separately checked and personally audited; "
    "no independent second reviewer is represented."
)

PRECHECK_SQL = """
SELECT
  current_user='vns'
  AND current_database()='videonews'
  AND current_setting('is_superuser')='on'
  AND current_setting('server_version_num') ~ '^17[0-9]{4}$'
  AND (SELECT count(*)=61 AND max(version)='0061_single_owner_review_policy'
       FROM vns.schema_migrations)
  AND (SELECT count(*)=1 FROM vns.editor_accounts WHERE role='admin')
  AND (SELECT count(*)=1 FROM vns.editor_accounts a
       JOIN vns.editor_db_principals p ON p.editor_id=a.id
       JOIN pg_roles r ON r.rolname=p.login_role
       WHERE a.username='vns_owner_admin' AND a.role='admin' AND a.active
         AND p.active AND p.auth_version=a.auth_version
         AND p.login_role='editor_vns_owner_admin'
         AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole)
  AND pg_has_role('editor_vns_owner_admin','vns_p2_named_client','member')
  AND (SELECT count(*)=1 FROM vns.single_owner_review_policy
       WHERE singleton=true AND enabled=false AND owner_editor_id IS NULL
         AND authorized_at IS NULL AND operator_reason IS NULL)
  AND (SELECT revision=0 AND sources='[]'::jsonb
       FROM vns.admin_source_registry WHERE singleton=true)
  AND (SELECT revision=0 AND approved_hosts='[]'::jsonb
       FROM vns.admin_source_host_approvals WHERE singleton=true)
  AND (SELECT count(*)=0 FROM vns.admin_source_audit)
  AND (SELECT count(*)=0 FROM vns.admin_source_host_audit)
  AND (SELECT count(*)=0 FROM vns.feed_event_rankings
       WHERE approved_for_publication)
  AND NOT has_table_privilege(
    'vns_p2_named_client','vns.single_owner_review_policy','UPDATE');
""".strip()

POSTCHECK_SQL = """
SELECT
  (SELECT count(*)=1
   FROM vns.single_owner_review_policy policy
   JOIN vns.editor_accounts account ON account.id=policy.owner_editor_id
   JOIN vns.editor_db_principals principal
     ON principal.editor_id=account.id
   WHERE policy.singleton=true AND policy.enabled=true
     AND account.username='vns_owner_admin' AND account.role='admin'
     AND account.active=true
     AND principal.login_role='editor_vns_owner_admin'
     AND principal.active=true AND principal.auth_version=account.auth_version
     AND policy.operator_reason IS NOT NULL
     AND length(policy.operator_reason) BETWEEN 30 AND 500
     AND policy.authorized_at IS NOT NULL)
  AND (SELECT revision=0 AND sources='[]'::jsonb
       FROM vns.admin_source_registry WHERE singleton=true)
  AND (SELECT revision=0 AND approved_hosts='[]'::jsonb
       FROM vns.admin_source_host_approvals WHERE singleton=true)
  AND (SELECT count(*)=0 FROM vns.admin_source_audit)
  AND (SELECT count(*)=0 FROM vns.admin_source_host_audit);
""".strip()

STATUS_SQL = """
SELECT CASE
  WHEN (SELECT count(*)=1
    FROM vns.single_owner_review_policy WHERE singleton=true AND enabled=false
      AND owner_editor_id IS NULL AND authorized_at IS NULL) THEN 'OFF'
  WHEN (SELECT count(*)=1
    FROM vns.single_owner_review_policy policy
    JOIN vns.editor_accounts account ON account.id=policy.owner_editor_id
    JOIN vns.editor_db_principals principal ON principal.editor_id=account.id
    WHERE policy.singleton=true AND policy.enabled=true
      AND account.username='vns_owner_admin' AND account.role='admin'
      AND account.active=true AND principal.login_role='editor_vns_owner_admin'
      AND principal.active=true AND principal.auth_version=account.auth_version)
    THEN 'SOLE_OWNER_ENABLED'
  ELSE 'INVALID' END;
""".strip()


def query(sql: str, *, readonly: bool = True) -> str:
    try:
        return db.query(db.CONTAINER, sql, readonly=readonly, timeout=35)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        raise RuntimeError(FAIL) from None


def git_sha() -> str:
    try:
        return db.git_sha()
    except (OSError, ValueError, RuntimeError):
        raise RuntimeError(FAIL) from None


def require_identity() -> str:
    sha = git_sha()
    try:
        db.container()
    except (OSError, ValueError, RuntimeError):
        raise RuntimeError(FAIL) from None
    return sha


def require_clean_owner() -> None:
    if query(PRECHECK_SQL) != "t":
        raise RuntimeError(FAIL)


def transaction() -> str:
    # No dynamic identifiers or caller-chosen UUIDs. Escaping is fixed by code.
    if not 30 <= len(REASON) <= 500 or "'" in REASON:
        raise RuntimeError(FAIL)
    return f"""BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
LOCK TABLE vns.admin_source_registry, vns.admin_source_host_approvals IN SHARE MODE;
DO $owner$
BEGIN
  IF NOT ({PRECHECK_SQL.rstrip(';')}) THEN
    RAISE EXCEPTION 'Owner policy preconditions changed'
      USING ERRCODE='42501';
  END IF;
  UPDATE vns.single_owner_review_policy
  SET enabled=true,
      owner_editor_id=(
        SELECT a.id FROM vns.editor_accounts a
        WHERE a.username='vns_owner_admin' AND a.role='admin'
          AND a.active=true
      ),
      operator_reason='{REASON}',
      authorized_at=clock_timestamp()
  WHERE singleton=true AND enabled=false
    AND owner_editor_id IS NULL AND authorized_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owner policy changed' USING ERRCODE='42501';
  END IF;
END
$owner$;
{POSTCHECK_SQL}
COMMIT;
"""


def apply(sha: str) -> None:
    if (os.getenv(ACK) != ACK_VALUE
            or os.getenv(SHA_ACK) != sha
            or not re.fullmatch(r"[a-f0-9]{40}", sha)):
        raise RuntimeError(FAIL)
    # Prevent application of stale release while operator is authorizing it.
    try:
        result = subprocess.run(
            ["git", "-C", str(db.ROOT), "ls-remote", "origin", "refs/heads/main"],
            capture_output=True, text=True, timeout=30, check=False
        )
        if result.returncode or result.stdout.strip().split() != [
            sha, "refs/heads/main"
        ]:
            raise RuntimeError(FAIL)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(FAIL) from None
    require_clean_owner()
    # psql -q -t prints one 't' before COMMIT; ON_ERROR_STOP denies failures.
    if query(transaction(), readonly=False) != "t":
        raise RuntimeError(FAIL)
    if query(POSTCHECK_SQL) != "t" or query(STATUS_SQL) != "SOLE_OWNER_ENABLED":
        raise RuntimeError(FAIL)
    print("PASS: exactly one existing personal owner enrolled")
    print("PASS: decisions are attributed to the same real owner, not a second reviewer")
    print("PASS: source and host registers remain empty; no feed activation")


def main(args: list[str]) -> None:
    if args not in (["--status"], ["--preflight"], ["--apply"]):
        raise RuntimeError(FAIL)
    sha = require_identity()
    if args == ["--status"]:
        status = query(STATUS_SQL)
        if status not in ("OFF", "SOLE_OWNER_ENABLED"):
            raise RuntimeError(FAIL)
        print("PASS: Single-Owner policy status: " + status)
        return
    if args == ["--preflight"]:
        require_clean_owner()
        print("PASS: named owner and empty source/host approval prerequisites")
        print("INFO: read-only; no policy, source, host or feed activation")
        return
    apply(sha)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, OverflowError, UnicodeError):
        raise SystemExit(FAIL)
