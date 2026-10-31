#!/usr/bin/env python3
"""P2-A: read-only, redacted VPS acceptance inventory (never a rollout permit).

Uses the existing Stage-A Docker/Git inventory, then two bounded read-only
PostgreSQL probes inside the exact Compose postgres container. Never reads
secrets, requests network access, performs writes, or impersonates an editor.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
from typing import Callable

from p2_02_stage_a_vps_inventory import inspect_stage_a, PROJECT

ROOT = Path(__file__).resolve().parent.parent
VERSIONS = ROOT / "db" / "migrations"
SHA = re.compile(r"^[a-f0-9]{40}$")
PROJECT_NAME = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
MIGRATION = re.compile(r"^[0-9]{4}_[a-z][a-z0-9_]{2,90}$")
EXPECTED_LAST = "0059_canonical_event_title_fingerprint"
MAX_OUTPUT = 16384
# These queries return only schema labels or aggregate integers: no article
# text, URL, source ID, editor identity, PG variable, token or key is emitted.
MIGRATION_SQL = "SELECT version FROM vns.schema_migrations ORDER BY version;"
AGGREGATE_SQL = """
SELECT json_build_object(
  'source_entries', jsonb_array_length(reg.sources),
  'approved_source_entries', (
    SELECT count(*) FROM jsonb_array_elements(reg.sources) AS source(value)
    WHERE source.value->>'status'='approved'
  ),
  'runtime_authorized_sources', (
    SELECT count(*) FROM jsonb_array_elements(reg.sources) AS source(value)
    WHERE source.value->>'status'='approved'
      AND vns.feed_runtime_source_authorized(source.value)
  ),
  'reviewed_publisher_groups', (
    SELECT count(DISTINCT proof.publisher_group)
    FROM vns.feed_publisher_provenance_reviews proof
    JOIN LATERAL jsonb_array_elements(reg.sources) source(value)
      ON source.value->>'id'=proof.source_id
    WHERE proof.source_revision=reg.revision
      AND source.value->>'status'='approved'
      AND vns.feed_runtime_source_authorized(source.value)
  ),
  'ranking_policies', (SELECT count(*) FROM vns.feed_ranking_policy_reviews),
  'event_factor_reviews', (SELECT count(*) FROM vns.feed_event_factor_reviews),
  'weighted_candidates', (
    SELECT count(*) FROM vns.feed_event_rankings
    WHERE policy_revision IS NOT NULL AND approved_for_publication=false
  ),
  'unexpected_published_rankings', (
    SELECT count(*) FROM vns.feed_event_rankings WHERE approved_for_publication=true
  )
) FROM vns.admin_source_registry reg WHERE reg.singleton=true;
""".strip()
REQUIRED_COUNTS = (
    "source_entries", "approved_source_entries", "runtime_authorized_sources",
    "reviewed_publisher_groups", "ranking_policies", "event_factor_reviews",
    "weighted_candidates", "unexpected_published_rankings",
)


def expected_migrations(migration_dir: Path = VERSIONS) -> list[str]:
    """Validate local release manifest without touching a database or network."""
    files = sorted(migration_dir.glob("*.up.sql"))
    names = [path.name.removesuffix(".up.sql") for path in files]
    if (
        len(names) not in (59, 60, 61)
        or names[58] != EXPECTED_LAST
        or (len(names) >= 60 and names[59] != "0060_named_source_host_admin_gateways")
        or (len(names) == 61 and names[60] != "0061_single_owner_review_policy")
        or [name[:4] for name in names] != [f"{i:04d}" for i in range(1, len(names) + 1)]
        or not all(MIGRATION.fullmatch(name) for name in names)
        or any(path.is_symlink() or not path.is_file() for path in files)
    ):
        raise ValueError("Unexpected release migration manifest")
    # This acceptance is strictly for the already-installed 0059 baseline.
    # Migration 0060 is reviewed separately; do not silently approve it here.
    return names[:59]


def postgres_read_only(container: str, sql: str) -> str:
    """Only exact local Compose container name, fixed SQL and read-only session."""
    if container != PROJECT + "-postgres-1":
        raise ValueError("Container name refused")
    if sql not in (MIGRATION_SQL, AGGREGATE_SQL):
        raise ValueError("Unapproved SQL refused")
    args = [
        "docker", "exec", "-i",
        "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
        container, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ]
    try:
        result = subprocess.run(
            args, input=sql + "\n", capture_output=True, text=True,
            check=False, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("PostgreSQL read-only probe unavailable") from None
    if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT:
        # Never expose stderr: database errors can contain private metadata.
        raise ValueError("PostgreSQL read-only probe unavailable")
    return result.stdout.strip()


def inspect_package_a(
    stage: dict,
    versions: list[str],
    run_sql: Callable[[str, str], str] = postgres_read_only,
) -> dict:
    """Compose redacted release checks; no individual source IDs are returned."""
    checks = {
        "stage_a_clean_expected_release": False,
        "postgres_running_healthy": False,
        "exact_schema_0001_0059": False,
        "three_to_five_source_approvals": False,
        "all_approved_sources_currently_authorized": False,
        "three_distinct_reviewed_publisher_groups": False,
        "reviewed_ranking_policies_exist": False,
        "event_factors_exist": False,
        "persisted_weighted_candidates_exist": False,
        "no_automatic_publication": False,
    }
    totals = None
    try:
        release = stage["release"]
        postgres = stage["docker"]["services"]["postgres"]
        project = stage["docker"]["project"]
        checks["stage_a_clean_expected_release"] = (
            stage["stage_a_readiness"] == "reviewable"
            and all(stage["checks"].values())
            and release["checkout_sha"] == release["expected_sha"]
            and release["tracked_worktree_clean"] is True
            and SHA.fullmatch(release["expected_sha"]) is not None
        )
        checks["postgres_running_healthy"] = (
            postgres["state"] == "running"
            and postgres["health"] == "healthy"
            and postgres["host_ports_published"] is False
            and PROJECT_NAME.fullmatch(project) is not None
        )
        if checks["stage_a_clean_expected_release"] and checks["postgres_running_healthy"]:
            container = project + "-postgres-1"
            installed = run_sql(container, MIGRATION_SQL).splitlines()
            checks["exact_schema_0001_0059"] = installed == versions and (
                len(versions) == 59 and versions[-1] == EXPECTED_LAST
            )
            if checks["exact_schema_0001_0059"]:
                raw = run_sql(container, AGGREGATE_SQL)
                data = json.loads(raw)
                if (
                    isinstance(data, dict)
                    and set(data) == set(REQUIRED_COUNTS)
                    and all(type(data[key]) is int and 0 <= data[key] <= 1000000 for key in REQUIRED_COUNTS)
                ):
                    totals = data
                    approved = data["approved_source_entries"]
                    checks["three_to_five_source_approvals"] = 3 <= approved <= 5
                    checks["all_approved_sources_currently_authorized"] = (
                        approved >= 3 and data["runtime_authorized_sources"] == approved
                    )
                    checks["three_distinct_reviewed_publisher_groups"] = (
                        data["reviewed_publisher_groups"] >= 3
                    )
                    checks["reviewed_ranking_policies_exist"] = data["ranking_policies"] > 0
                    checks["event_factors_exist"] = data["event_factor_reviews"] > 0
                    checks["persisted_weighted_candidates_exist"] = data["weighted_candidates"] > 0
                    checks["no_automatic_publication"] = data["unexpected_published_rankings"] == 0
    except (ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError):
        pass  # Fail closed, never leak SQL or Docker stderr.

    return {
        "schema_version": 1,
        "scope": "read_only_p2_a_vps_preflight",
        "checks": checks,
        "totals": totals,
        "operator_e2e_preflight": "reviewable" if all(checks.values()) else "blocked",
        "independent_evidence": {
            "source_legal_rights": "not_verified",
            "personally_authenticated_admin_read": "not_verified",
            "real_feed_fetch_and_restarts": "not_verified",
            "editorial_claim_review": "not_verified",
        },
        "production_authorized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Redacted P2-A read-only VPS preflight")
    parser.add_argument("--repo", default="/home/ap/www/videonews-studio")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--project-name", default=PROJECT)
    args = parser.parse_args()
    try:
        if SHA.fullmatch(args.expected_sha) is None:
            raise ValueError("Invalid SHA")
        versions = expected_migrations()
        stage = inspect_stage_a(
            repo_dir=args.repo, expected_sha=args.expected_sha,
            project_name=args.project_name,
        )
        result = inspect_package_a(stage, versions)
    except (ValueError, TypeError):
        result = {"schema_version": 1, "scope": "read_only_p2_a_vps_preflight",
                  "operator_e2e_preflight": "blocked", "production_authorized": False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["operator_e2e_preflight"] == "reviewable" else 2


if __name__ == "__main__":
    raise SystemExit(main())
