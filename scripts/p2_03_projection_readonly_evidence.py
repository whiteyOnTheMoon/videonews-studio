#!/usr/bin/env python3
"""P2-03 metadata-only production evidence. Strictly read-only; no feed start.

Uses the existing healthy Compose PostgreSQL through docker exec with
default_transaction_read_only=on. Prints only bounded aggregate counters,
never article URLs, headlines, tokens, RSS bodies or SQL exceptions.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DB_CONTAINER = "videonews-studio-postgres-1"
SHA = re.compile(r"[a-f0-9]{40}\Z")
SOURCE = re.compile(r"[a-z][a-z0-9_-]{2,40}\Z")
REFUSED = "REFUSED: P2-03 read-only evidence unavailable; do not start a feed"

COUNTERS = (
    "feed_candidates",
    "eligible_candidates",
    "projected_articles",
    "projected_events",
    "multi_article_events",
    "multi_source_events",
    "ranked_events",
    "unmapped_eligible_candidates",
    "immutable_metadata_conflicts",
    "event_window_violations",
    "publication_violations",
)


def command(args: list[str], payload: str | None = None) -> str:
    try:
        result = subprocess.run(
            args, input=payload, capture_output=True, text=True,
            check=False, timeout=20,
        )
        if result.returncode != 0 or len(result.stdout) > 8192:
            raise RuntimeError(REFUSED)
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None


def verify_release(expected_sha: str) -> None:
    if (
        not SHA.fullmatch(expected_sha)
        or os.geteuid() != 1000
        or pwd.getpwuid(os.getuid()).pw_name != "ap"
    ):
        raise RuntimeError(REFUSED)
    git = ["git", "-c", "safe.directory=" + str(ROOT), "-C", str(ROOT)]
    if (
        command(git + ["branch", "--show-current"]) != "main"
        or command(git + ["rev-parse", "HEAD"]) != expected_sha
        or command(git + ["status", "--porcelain"]) != ""
    ):
        raise RuntimeError(REFUSED)
    label = command([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        DB_CONTAINER,
    ])
    if label != "videonews-studio|postgres|healthy":
        raise RuntimeError(REFUSED)


def evidence_sql(source_id: str) -> str:
    if not SOURCE.fullmatch(source_id):
        raise ValueError(REFUSED)
    # Source is restricted to a strict lowercase identifier, not an SQL
    # fragment. Query never reads raw article URLs, text or private secrets.
    return f"""
WITH
registry AS (
 SELECT r.revision AS source_revision, entry.value AS item
 FROM vns.admin_source_registry r
 CROSS JOIN LATERAL jsonb_array_elements(r.sources) AS entry(value)
 WHERE r.singleton=true AND entry.value->>'id'='{source_id}'
),
candidates AS (
 SELECT c.published_at,
        a.article_id,
        ea.event_id,
        coalesce(
          a.source_key=c.source_id
          AND a.headline=c.headline
          AND a.published_at=c.published_at,
          false
        ) AS identity_matches
 FROM vns.feed_poll_candidates c
 LEFT JOIN vns.research_articles a ON a.canonical_url=c.article_url
 LEFT JOIN vns.research_event_articles ea ON ea.article_id=a.article_id
 WHERE c.source_id='{source_id}' AND c.review_status='candidate'
),
affected_events AS (
 SELECT DISTINCT event_id
 FROM candidates
 WHERE identity_matches AND event_id IS NOT NULL
),
event_members AS (
 SELECT ae.event_id, count(*)::integer AS article_count,
   count(DISTINCT a.source_key)::integer AS source_count,
   max(a.published_at)-min(a.published_at) AS time_spread
 FROM affected_events ae
 JOIN vns.research_event_articles ea ON ea.event_id=ae.event_id
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 GROUP BY ae.event_id
)
SELECT jsonb_build_object(
 'schema_ready',
   (SELECT count(*)=3 FROM vns.schema_migrations
      WHERE version IN ('0049_approved_feed_rankings',
                        '0056_failclosed_ranked_feed_read',
                        '0059_canonical_event_title_fingerprint')),
 'source_authorized',
   -- A read-only MVCC snapshot of the existing audited source/host state.
   -- The runtime authorization function uses FOR SHARE and cannot be
   -- called from default_transaction_read_only=on. This status is evidence,
   -- NOT an authorization token or substitute for the guarded writer.
   coalesce((SELECT count(*)=1 AND bool_and(
      jsonb_typeof(item)='object'
      AND (SELECT count(*) FROM jsonb_object_keys(item)) IN (9,10)
      AND ((SELECT count(*) FROM jsonb_object_keys(item))=9
           OR item ? 'feedUrl')
      AND item ?& ARRAY['id','baseUrl','access','intervalMinutes',
                        'termsUrl','usage','licenseNotes','status','reviewedAt']
      AND item->>'status'='approved'
      AND (NOT (item ? 'feedUrl') OR (
        jsonb_typeof(item->'feedUrl')='string'
        AND item->>'feedUrl' IS DISTINCT FROM item->>'baseUrl'
        AND split_part(split_part(item->>'feedUrl','https://',2),'/',1)
            =split_part(split_part(item->>'baseUrl','https://',2),'/',1)
      ))
      AND EXISTS(
        SELECT 1
        FROM vns.admin_source_host_approvals h
        JOIN LATERAL (
          SELECT a.action,a.source_revision
          FROM vns.admin_source_host_audit a
          WHERE a.host=split_part(
            split_part(registry.item->>'baseUrl','https://',2),'/',1)
          ORDER BY a.revision DESC LIMIT 1
        ) latest ON true
        WHERE h.singleton=true
          AND h.approved_hosts ? split_part(
            split_part(registry.item->>'baseUrl','https://',2),'/',1)
          AND latest.action='grant'
          AND latest.source_revision=registry.source_revision
      )
   ) FROM registry),false),
 'feed_candidates',(SELECT count(*) FROM candidates),
 'eligible_candidates',(SELECT count(*) FROM candidates
   WHERE published_at IS NOT NULL AND published_at<=clock_timestamp()),
 'projected_articles',(SELECT count(*) FROM candidates
   WHERE identity_matches AND event_id IS NOT NULL),
 'projected_events',(SELECT count(*) FROM affected_events),
 'multi_article_events',(SELECT count(*) FROM event_members WHERE article_count>1),
 'multi_source_events',(SELECT count(*) FROM event_members WHERE source_count>1),
 'ranked_events',(SELECT count(DISTINCT r.event_id)
   FROM vns.feed_event_rankings r
   JOIN affected_events e ON e.event_id=r.event_id
   JOIN vns.editorial_profile_registry p ON p.singleton
     AND p.revision=r.profile_revision
   WHERE r.approved_for_publication=false),
 'unmapped_eligible_candidates',(SELECT count(*) FROM candidates
   WHERE published_at IS NOT NULL AND published_at<=clock_timestamp()
     AND (NOT identity_matches OR event_id IS NULL)),
 'immutable_metadata_conflicts',(SELECT count(*) FROM candidates
   WHERE article_id IS NOT NULL AND NOT identity_matches),
 'event_window_violations',(SELECT count(*) FROM event_members
   WHERE time_spread>interval '48 hours'),
 'publication_violations',(SELECT count(*) FROM vns.feed_event_rankings r
   JOIN affected_events e ON e.event_id=r.event_id
   WHERE r.approved_for_publication=true)
);
"""


def validate_evidence(row: object) -> dict[str, object]:
    if not isinstance(row, dict) or set(row) != set(COUNTERS) | {
        "schema_ready", "source_authorized"
    }:
        raise ValueError(REFUSED)
    for name in ("schema_ready", "source_authorized"):
        if type(row[name]) is not bool:
            raise ValueError(REFUSED)
    for name in COUNTERS:
        if type(row[name]) is not int or not 0 <= row[name] <= 1000000000:
            raise ValueError(REFUSED)
    if (
        row["eligible_candidates"] > row["feed_candidates"]
        or row["projected_articles"] > row["feed_candidates"]
        or row["projected_events"] > row["projected_articles"]
        or row["multi_source_events"] > row["multi_article_events"]
        or row["multi_article_events"] > row["projected_events"]
        or row["ranked_events"] > row["projected_events"]
        or row["event_window_violations"] > row["projected_events"]
        or (row["publication_violations"] > 0 and row["projected_events"] == 0)
        or row["unmapped_eligible_candidates"] > row["eligible_candidates"]
        or row["immutable_metadata_conflicts"] > row["feed_candidates"]
    ):
        raise ValueError(REFUSED)
    return row


def evidence_status(row: dict[str, object]) -> str:
    if not row["schema_ready"] or not row["source_authorized"]:
        return "blocked_schema_or_source_approval"
    if (
        row["immutable_metadata_conflicts"]
        or row["event_window_violations"]
        or row["publication_violations"]
    ):
        return "blocked_persistence_invariant"
    if row["feed_candidates"] == 0:
        return "awaiting_p2_02_persistence"
    if row["projected_articles"] == 0 or row["unmapped_eligible_candidates"]:
        return "awaiting_or_incomplete_projector"
    if row["multi_source_events"] == 0:
        return "awaiting_multisource_duplicate_evidence"
    if row["ranked_events"] == 0:
        return "awaiting_ranked_admin_evidence"
    return "requires_named_admin_and_provenance_review"


def inspect(expected_sha: str, source_id: str) -> dict[str, object]:
    if not SOURCE.fullmatch(source_id):
        raise ValueError(REFUSED)
    verify_release(expected_sha)
    output = command([
        "docker", "exec", "-i", "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 "
        "-c lock_timeout=3000",
        DB_CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], evidence_sql(source_id))
    try:
        row = validate_evidence(json.loads(output))
    except (json.JSONDecodeError, ValueError, TypeError):
        raise RuntimeError(REFUSED) from None
    return {
        "scope": "p2_03_read_only_persistence_evidence",
        "source_id": source_id,
        "release": expected_sha,
        **row,
        "status": evidence_status(row),
        "feed_started": False,
        "database_changed": False,
        "queue_changed": False,
        "checkpoint_changed": False,
        "publication_authorized": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only P2-03 metadata evidence")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--source-id", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.expected_sha, args.source_id), sort_keys=True))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError):
        raise SystemExit(REFUSED) from None


if __name__ == "__main__":
    main()
