#!/usr/bin/env python3
"""P2-04 production readiness counters only; never a ranking or publish permit.

Requires an explicitly pinned clean main checkout and the healthy existing
PostgreSQL service. Uses an intentionally read-only SQL session; no source
network access, raw headlines, URLs, identities, credentials or content logs.
"""
from __future__ import annotations

import argparse
import json
import re
from typing import Any

from p2_03_projection_readonly_evidence import (
    DB_CONTAINER,
    command,
    verify_release,
)

SOURCE = re.compile(r"[a-z][a-z0-9_-]{2,40}\Z")
REFUSED = "REFUSED: P2-04 read-only multisource readiness unavailable; do not start a feed"
COUNT_FIELDS = (
    "candidate_count",
    "mapped_article_count",
    "mapped_event_count",
    "age_eligible_mapped_articles",
)
TOTAL_FIELDS = (
    "profile_count",
    "recent_distinct_source_ids",
    "shared_events",
    "time_compatible_cross_source_pairs",
    "ranked_events",
    "publication_violations",
)


def parse_sources(value: str) -> tuple[str, ...]:
    if not isinstance(value, str):
        raise ValueError(REFUSED)
    parts = value.split(",")
    if (
        not 2 <= len(parts) <= 5
        or any(not SOURCE.fullmatch(part) for part in parts)
        or len(set(parts)) != len(parts)
    ):
        raise ValueError(REFUSED)
    return tuple(sorted(parts))


def readiness_sql(sources: tuple[str, ...]) -> str:
    if not isinstance(sources, tuple) or parse_sources(",".join(sources)) != sources:
        raise ValueError(REFUSED)
    # All quoted values come exclusively from the strict lowercase ID validator.
    values = ",".join("('" + source + "')" for source in sources)
    return f"""
WITH chosen(source_id) AS (VALUES {values}),
registry AS (
  SELECT r.revision, entry.value AS item
  FROM vns.admin_source_registry r
  CROSS JOIN LATERAL jsonb_array_elements(r.sources) entry(value)
  WHERE r.singleton=true
),
profiles AS (
  SELECT (p.value->>'maximumArticleAgeHours')::integer AS max_age
  FROM vns.editorial_profile_registry r
  CROSS JOIN LATERAL jsonb_array_elements(r.profiles) p(value)
  WHERE r.singleton=true
),
sources AS (
  SELECT c.source_id,
    r.item IS NOT NULL AS registered,
    COALESCE(r.item->>'status'='approved',false) AS approved,
    COALESCE(
      r.item IS NOT NULL AND EXISTS (
        SELECT 1
        FROM vns.admin_source_host_approvals h
        JOIN LATERAL (
          SELECT a.action,a.source_revision
          FROM vns.admin_source_host_audit a
          WHERE a.host=split_part(
            split_part(r.item->>'baseUrl','https://',2),'/',1)
          ORDER BY a.revision DESC LIMIT 1
        ) latest ON true
        WHERE h.singleton=true
          AND h.approved_hosts ? split_part(
            split_part(r.item->>'baseUrl','https://',2),'/',1)
          AND latest.action='grant'
          AND latest.source_revision=r.revision
      ),false
    ) AS current_host_grant,
    COALESCE(EXISTS (
      SELECT 1 FROM vns.feed_publisher_provenance_reviews p
      WHERE p.source_id=c.source_id AND p.source_revision=r.revision
    ),false) AS publisher_reviewed
  FROM chosen c
  LEFT JOIN registry r ON r.item->>'id'=c.source_id
),
mapped AS (
  SELECT a.article_id,a.source_key,a.published_at,ea.event_id
  FROM vns.research_articles a
  JOIN chosen s ON s.source_id=a.source_key
  JOIN vns.research_event_articles ea ON ea.article_id=a.article_id
),
summary AS (
  SELECT s.source_id,s.registered,s.approved,s.current_host_grant,
         s.publisher_reviewed,
    (SELECT count(*) FROM vns.feed_poll_candidates c
     WHERE c.source_id=s.source_id AND c.review_status='candidate'
    ) AS candidate_count,
    (SELECT count(DISTINCT m.article_id) FROM mapped m
     WHERE m.source_key=s.source_id) AS mapped_article_count,
    (SELECT count(DISTINCT m.event_id) FROM mapped m
     WHERE m.source_key=s.source_id) AS mapped_event_count,
    (SELECT count(DISTINCT m.article_id)
     FROM mapped m CROSS JOIN profiles p
     WHERE m.source_key=s.source_id
       AND m.published_at BETWEEN
           clock_timestamp()-p.max_age*interval '1 hour'
           AND clock_timestamp()
    ) AS age_eligible_mapped_articles
  FROM sources s
),
shared AS (
  SELECT event_id
  FROM mapped
  GROUP BY event_id
  HAVING count(DISTINCT source_key)>=2
)
SELECT jsonb_build_object(
  'read_only',current_setting('transaction_read_only')='on',
  'sources',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'source_id',source_id,'registered',registered,
      'approved',approved,'current_host_grant',current_host_grant,
      'publisher_reviewed',publisher_reviewed,
      'candidate_count',candidate_count,
      'mapped_article_count',mapped_article_count,
      'mapped_event_count',mapped_event_count,
      'age_eligible_mapped_articles',age_eligible_mapped_articles
    ) ORDER BY source_id),'[]'::jsonb)
    FROM summary
  ),
  'profile_count',(SELECT count(*) FROM profiles),
  'recent_distinct_source_ids',(
    SELECT count(*) FROM summary WHERE age_eligible_mapped_articles>0
  ),
  'shared_events',(SELECT count(*) FROM shared),
  'time_compatible_cross_source_pairs',(
    SELECT count(*) FROM mapped a JOIN mapped b
      ON a.article_id<b.article_id
      AND a.source_key<>b.source_key
      AND a.published_at IS NOT NULL
      AND b.published_at IS NOT NULL
      AND abs(extract(epoch FROM a.published_at-b.published_at))<=172800
  ),
  'ranked_events',(
    SELECT count(DISTINCT r.event_id)
    FROM vns.feed_event_rankings r
    JOIN (SELECT DISTINCT event_id FROM mapped) events
      ON events.event_id=r.event_id
    JOIN vns.editorial_profile_registry p
      ON p.singleton=true AND p.revision=r.profile_revision
  ),
  'publication_violations',(
    SELECT count(*) FROM vns.feed_event_rankings r
    JOIN (SELECT DISTINCT event_id FROM mapped) events
      ON events.event_id=r.event_id
    WHERE r.approved_for_publication=true
  )
);
"""


def _count(value: Any) -> bool:
    return type(value) is int and 0 <= value <= 1_000_000_000


def validate(row: object, source_ids: tuple[str, ...]) -> dict[str, Any]:
    if (
        not isinstance(row, dict)
        or set(row) != set(TOTAL_FIELDS) | {"read_only", "sources"}
        or row["read_only"] is not True
        or not isinstance(row["sources"], list)
        or len(row["sources"]) != len(source_ids)
        or any(not _count(row[key]) for key in TOTAL_FIELDS)
        or row["recent_distinct_source_ids"] > len(source_ids)
    ):
        raise ValueError(REFUSED)
    expected = {
        "source_id", "registered", "approved", "current_host_grant",
        "publisher_reviewed", *COUNT_FIELDS,
    }
    for i, source in enumerate(source_ids):
        item = row["sources"][i]
        if (
            not isinstance(item, dict)
            or set(item) != expected
            or item["source_id"] != source
            or any(type(item[key]) is not bool for key in (
                "registered", "approved", "current_host_grant", "publisher_reviewed"
            ))
            or any(not _count(item[key]) for key in COUNT_FIELDS)
            or item["age_eligible_mapped_articles"] > item["mapped_article_count"]
            or item["mapped_event_count"] > item["mapped_article_count"]
            or (
                item["current_host_grant"] or item["approved"]
                or item["publisher_reviewed"]
            ) and not item["registered"]
        ):
            raise ValueError(REFUSED)
    if (
        row["recent_distinct_source_ids"] != sum(
            int(s["age_eligible_mapped_articles"] > 0) for s in row["sources"]
        )
        or row["shared_events"] > sum(s["mapped_event_count"] for s in row["sources"])
        or (row["shared_events"] > 0 and sum(
            int(s["mapped_event_count"] > 0) for s in row["sources"]
        ) < 2)
        or (row["ranked_events"] > 0 and sum(
            s["mapped_event_count"] for s in row["sources"]
        ) == 0)
    ):
        raise ValueError(REFUSED)
    return row


def status(row: dict[str, Any]) -> str:
    if row["publication_violations"]:
        return "blocked_publication_invariant"
    if any(
        not s["registered"] or not s["approved"] or not s["current_host_grant"]
        for s in row["sources"]
    ):
        return "blocked_source_grant_snapshot"
    if row["profile_count"] == 0:
        return "awaiting_editorial_profiles"
    if row["recent_distinct_source_ids"] < 2:
        return "awaiting_recent_multisource_input"
    if row["shared_events"] == 0:
        return "awaiting_multisource_event_evidence"
    if any(
        s["mapped_article_count"] > 0 and not s["publisher_reviewed"]
        for s in row["sources"]
    ):
        return "awaiting_publisher_provenance_review"
    if row["ranked_events"] == 0:
        return "awaiting_ranked_persistence"
    return "requires_named_admin_and_human_acceptance"


def inspect(expected_sha: str, source_ids: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(source_ids, tuple) or parse_sources(",".join(source_ids)) != source_ids:
        raise ValueError(REFUSED)
    verify_release(expected_sha)
    output = command([
        "docker", "exec", "-i", "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 "
        "-c lock_timeout=3000",
        DB_CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], readiness_sql(source_ids))
    try:
        row = validate(json.loads(output), source_ids)
    except (TypeError, ValueError, json.JSONDecodeError):
        raise RuntimeError(REFUSED) from None
    return {
        "scope": "p2_04_read_only_multisource_readiness",
        "release": expected_sha,
        **row,
        "status": status(row),
        "snapshot_not_runtime_authorization": True,
        "feed_started": False,
        "database_changed": False,
        "queue_changed": False,
        "publication_authorized": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only P2-04 source and ranking readiness")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--source-ids", required=True, help="2 to 5 comma-separated approved IDs")
    args = parser.parse_args()
    try:
        source_ids = parse_sources(args.source_ids)
        print(json.dumps(inspect(args.expected_sha, source_ids), sort_keys=True))
    except (OSError, RuntimeError, TypeError, ValueError, KeyError):
        raise SystemExit(REFUSED) from None


if __name__ == "__main__":
    main()
