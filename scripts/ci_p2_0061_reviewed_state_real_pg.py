#!/usr/bin/env python3
"""Disposable PostgreSQL 17 upgrade test, never a production operator command.

Exercise the actual, unmodified 0059->0061 SQL through the reviewed-state
operator preflight and the additive migration runner on nonempty existing
source/host registers with historical audit rows. No Docker/VPS access.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import p2_01_schema_0059_to_0061 as upgrade

ROOT = Path(__file__).resolve().parent.parent
FAIL = "REFUSED: disposable reviewed-registry PostgreSQL migration test"

def require_ci() -> None:
    if (
        os.getenv("CI") != "true"
        or os.getenv("GITHUB_ACTIONS") != "true"
        or os.getenv("VNS_P2_0061_ISOLATED_TEST") != "true"
        or os.getenv("PGHOST") != "127.0.0.1"
        or os.getenv("PGPORT") != "5432"
        or os.getenv("PGDATABASE") != "vns_p2_0061_ci"
        or os.getenv("PGUSER") != "postgres"
        or os.getenv("VNS_P2_0061_APPLY_APPROVED") is not None
        or os.getenv("VNS_P2_0061_REVIEWED_STATE_APPROVED") is not None
    ):
        raise RuntimeError(FAIL)

def isolated_psql(query: str, *, readonly: bool = True, timeout: int = 140) -> str:
    if not isinstance(query, str) or len(query) > 250_000:
        raise RuntimeError(FAIL)
    if timeout not in (40, 140):
        raise RuntimeError(FAIL)
    options = "-c lock_timeout=3000 -c statement_timeout=60000"
    if readonly:
        options += " -c default_transaction_read_only=on"
    try:
        result = subprocess.run(
            ["psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
            input=query + "\n",
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "PGOPTIONS": options},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(FAIL) from None
    if result.returncode != 0 or len(result.stdout) > 16_384:
        # Do not dump PostgreSQL diagnostics, even for disposable CI data.
        raise RuntimeError(FAIL)
    return result.stdout.strip()

SEED = """
BEGIN;
-- Physical session_user operator enrollment is mandatory even for CI.
INSERT INTO vns.editor_operator_registry
  (login_role,operator_id,operator_label,active)
VALUES (
  'postgres','fa620099-9999-4999-8999-999999999999',
  'Disposable CI-only database operator',true
);
INSERT INTO vns.editor_accounts (
  id,username,display_name,role,password_hash,active
) VALUES (
  'fa620001-1111-4111-8111-111111111111',
  'ci_existing_owner','CI-only editor','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true
);
UPDATE vns.admin_source_registry
 SET revision=8,
     sources=jsonb_build_array(
       jsonb_build_object('id','ci_source_alpha','status','approved',
         'baseUrl','https://alpha.example.org/news/'),
       jsonb_build_object('id','ci_source_beta','status','approved',
         'baseUrl','https://beta.example.org/news/'),
       jsonb_build_object('id','ci_source_gamma','status','approved',
         'baseUrl','https://gamma.example.org/news/')
     )
 WHERE singleton=true AND revision=0;
UPDATE vns.admin_source_host_approvals
 SET revision=7,
     approved_hosts='["alpha.example.org","beta.example.org","gamma.example.org"]'::jsonb
 WHERE singleton=true AND revision=0;
INSERT INTO vns.admin_source_audit
 (revision,source_id,action,editor_id,editor_username,
  editor_auth_version,recorded_at)
 SELECT seq,
        (ARRAY['ci_source_alpha','ci_source_beta','ci_source_gamma'])
        [1 + ((seq - 1) % 3)],
        CASE WHEN seq<=3 THEN 'create_pending' ELSE 'approve' END,
        'fa620001-1111-4111-8111-111111111111'::uuid,
        'ci_existing_owner',0,
        '2026-10-01T00:00:00Z'::timestamptz + seq*interval '1 minute'
 FROM generate_series(1,8) AS seq;
INSERT INTO vns.admin_source_host_audit
 (revision,source_revision,action,host,reason,editor_id,
  editor_username,editor_auth_version,recorded_at)
 SELECT seq,8,
        CASE WHEN seq IN (4,5) THEN 'revoke' ELSE 'grant' END,
        CASE
          WHEN seq IN (4,6) THEN 'alpha.example.org'
          WHEN seq IN (5,7) THEN 'beta.example.org'
          ELSE (ARRAY['alpha.example.org','beta.example.org','gamma.example.org'])
               [seq]
        END,
        'Synthetic independent CI review of metadata host access.',
        'fa620001-1111-4111-8111-111111111111'::uuid,
        'ci_existing_owner',0,
        '2026-10-01T00:00:00Z'::timestamptz + seq*interval '2 minutes'
 FROM generate_series(1,7) AS seq;
COMMIT;
"""

def main() -> None:
    require_ci()
    names = upgrade.expected_versions()
    if len(names) != 61:
        raise RuntimeError(FAIL)
    for i, name in enumerate(names[:59]):
        path = ROOT / "db" / "migrations" / (name + ".up.sql")
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(FAIL)
        isolated_psql(path.read_text(encoding="utf-8"), readonly=False)
        ledger = isolated_psql("SELECT count(*) FROM vns.schema_migrations;")
        if ledger != str(i + 1):
            raise RuntimeError(FAIL)

    isolated_psql(SEED, readonly=False)
    # The SQL preflight must refuse audit ledger gaps, stale approvals,
    # and host grants inconsistent with the final registry. All scenarios
    # are rolled back; the approved synthetic baseline remains unchanged.
    def invalid_in_transaction(mutation: str) -> None:
        result = isolated_psql(
            "BEGIN;\n" + mutation + "\n" + upgrade.REVIEWED_STATE_SQL +
            "\nROLLBACK;",
            readonly=False,
        )
        if result != "f":
            raise RuntimeError(FAIL)

    invalid_in_transaction(
        "UPDATE vns.admin_source_registry SET revision=9 WHERE singleton=true;"
    )
    invalid_in_transaction(
        "UPDATE vns.admin_source_host_approvals "
        "SET approved_hosts='[\"unreviewed.example.org\"]'::jsonb "
        "WHERE singleton=true;"
    )
    invalid_in_transaction(
        "UPDATE vns.admin_source_registry SET revision=9 WHERE singleton=true;\n"
        "INSERT INTO vns.admin_source_audit("
        "revision,source_id,action,editor_id,editor_username,"
        "editor_auth_version,recorded_at) VALUES (9,'ci_source_alpha','block',"
        "'fa620001-1111-4111-8111-111111111111',"
        "'ci_existing_owner',0,'2026-10-01T01:00:00Z'::timestamptz);"
    )

    with (
        patch.object(upgrade, "sql", side_effect=isolated_psql),
        patch.object(upgrade, "check_safety", return_value=None),
    ):
        # CI skips ONLY operator VPS identity, resource and Docker checks;
        # actual database roles, catalog, registry and SQL are all real.
        before = upgrade.preflight(names, reviewed_state=True)
        original_audits = upgrade.sql(upgrade.REVIEWED_AUDIT_SNAPSHOT_SQL)
        if not original_audits.startswith("8:") or "|7:" not in original_audits:
            raise RuntimeError(FAIL)
        try:
            upgrade.preflight(names)
        except RuntimeError:
            pass
        else:
            raise RuntimeError(FAIL)  # Old empty-registry mode must refuse.

        upgrade.apply(names, before, reviewed_state=True, audit_snapshot=original_audits)
        upgrade.final_check(names, before, reviewed_state=True,
                            audit_snapshot=original_audits)

        if upgrade.ledger() != names:
            raise RuntimeError(FAIL)
        if upgrade.sql(upgrade.prior.UNCHANGED_SQL) != before:
            raise RuntimeError(FAIL)
        if upgrade.sql(upgrade.REVIEWED_AUDIT_SNAPSHOT_SQL) != original_audits:
            raise RuntimeError(FAIL)
        if upgrade.sql(upgrade.REVIEWED_STATE_SQL) != "t":
            raise RuntimeError(FAIL)
        if upgrade.sql(upgrade.FINAL_SQL) != "t":
            raise RuntimeError(FAIL)
        # Verify exact 0061 historical audit model without altering it.
        if upgrade.sql(
            "SELECT count(*) FROM vns.admin_source_host_audit "
            "WHERE approval_model='two_person';"
        ) != "7":
            raise RuntimeError(FAIL)
        if upgrade.sql(
            "SELECT enabled::text || '|' || (owner_editor_id IS NULL)::text "
            "FROM vns.single_owner_review_policy WHERE singleton=true;"
        ) != "false|true":
            raise RuntimeError(FAIL)
        try:
            upgrade.preflight(names, reviewed_state=True)
        except RuntimeError:
            pass
        else:
            raise RuntimeError(FAIL)  # No second upgrade or auto-resume.

    print("PASS: real PostgreSQL 17 schema 0059 -> 0061 preserving three sources and three hosts")
    print("PASS: nonzero source/host revisions and all historical audits unchanged")
    print("PASS: policy defaults OFF; old empty-state upgrade and rerun refused")
    print("INFO: CI-only; no source rights, VPS migration or live feed approved")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(FAIL, file=sys.stderr)
        sys.exit(2)
