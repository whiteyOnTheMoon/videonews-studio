#!/usr/bin/env python3
"""P2-03 NOAA DB-only projection preflight. Read-only; never starts a projector.

Run as root for existing protected mount inspection. Git commands must not
refresh ap's index. A PASS is NOT permission to execute a projection.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path("/home/ap/www/videonews-studio")
EXPECTED_IMAGE = "vns-p2-worker:a5c73c9ea5b8"
EXPECTED_IMAGE_ID = (
    "sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef"
)
EXPECTED_WORKER_SHA = "a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031"
SINGLE_CONTAINER = "vns-noaa-project-20261108-a5c73c9"
SECRET_DIR = Path("/var/lib/videonews-studio/p2-feed-runtime-secrets")
SECRET = SECRET_DIR / "vns_feed_project_db_password"
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
EXPECTED_PROJECTOR_LOGIN = "vns_feed_project_login_prod"
DENIED = "REFUSED: P2-03 NOAA projection preflight unavailable; no projection permitted"

SQL = r"""
WITH registry AS (
  SELECT r.revision, r.sources, item.value AS entry
  FROM vns.admin_source_registry r
  CROSS JOIN LATERAL jsonb_array_elements(r.sources) item(value)
  WHERE r.singleton AND item.value->>'id'='noaa_news'
),
candidates AS (
  SELECT c.source_id,c.article_url,c.headline,c.published_at,a.article_id,
    COALESCE(a.source_key=c.source_id AND a.headline=c.headline
      AND a.published_at=c.published_at,false) AS identity_matches,
    EXISTS (SELECT 1 FROM vns.research_event_articles ea
            WHERE ea.article_id=a.article_id) AS mapped
  FROM vns.feed_poll_candidates c
  LEFT JOIN vns.research_articles a ON a.canonical_url=c.article_url
  WHERE c.source_id='noaa_news' AND c.review_status='candidate'
),
missing AS (SELECT * FROM candidates WHERE article_id IS NULL),
projector_roles AS (
  SELECT r.rolname,
    (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole
     AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
     AND pg_has_role(r.rolname,'vns_feed_project_client','member')
     AND has_function_privilege(r.rolname,
       'vns.project_approved_feed_candidates(text,integer)','EXECUTE')
    ) AS authorized,
    (has_function_privilege(r.rolname,
       'vns.project_feed_candidates(text,integer)','EXECUTE')
     OR has_table_privilege(r.rolname,'vns.feed_poll_candidates','SELECT')
     OR has_table_privilege(r.rolname,'vns.research_claims','SELECT')
     OR has_table_privilege(r.rolname,'vns.research_events','INSERT')
     OR has_table_privilege(r.rolname,'vns.editor_accounts','UPDATE')
     OR has_function_privilege(r.rolname,
       'vns.claim_feed_poll(text,integer)','EXECUTE')
    ) AS forbidden_access
  FROM pg_catalog.pg_roles r
  WHERE r.rolname ~ '^vns_feed_project_login_[a-z0-9_]{3,24}$'
)
SELECT jsonb_build_object(
  'read_only',current_setting('transaction_read_only')='on',
  'schema_ready',(SELECT count(*)=3 FROM vns.schema_migrations
    WHERE version IN ('0035_approved_feed_candidate_projection',
      '0049_approved_feed_rankings','0059_canonical_event_title_fingerprint')),
  'source_ready',(SELECT count(*)=1 AND bool_and(
      revision=10 AND entry->>'status'='approved'
      AND entry->>'access'='rss' AND entry->>'usage'='metadata_only'
      AND entry->>'baseUrl'='https://www.noaa.gov/'
      AND entry->>'feedUrl'='https://www.noaa.gov/rss.xml'
      AND entry->>'intervalMinutes'='60') FROM registry),
  'host_grant_ready',EXISTS (
    SELECT 1 FROM vns.admin_source_host_approvals h
    JOIN LATERAL (
      SELECT a.action,a.source_revision FROM vns.admin_source_host_audit a
      WHERE a.host='www.noaa.gov' ORDER BY a.revision DESC LIMIT 1
    ) last ON true
    WHERE h.singleton AND h.approved_hosts ? 'www.noaa.gov'
      AND last.action='grant' AND last.source_revision=10
  ),
  'candidates',(SELECT count(*) FROM candidates),
  'projected',(SELECT count(*) FROM candidates WHERE identity_matches AND mapped),
  'missing',(SELECT count(*) FROM missing),
  'selectable_missing',(SELECT count(*) FROM missing
    WHERE published_at IS NOT NULL AND published_at<=clock_timestamp()
      AND article_url ~ '^https://[^[:space:]?#]+$'),
  'age_eligible_missing',(SELECT count(*) FROM missing m
    CROSS JOIN vns.editorial_profile_registry pr
    CROSS JOIN LATERAL jsonb_array_elements(pr.profiles) prof(value)
    WHERE pr.singleton AND m.published_at BETWEEN
      clock_timestamp()-(prof.value->>'maximumArticleAgeHours')::integer
        *interval '1 hour' AND clock_timestamp()),
  'older_than_48_hours',(SELECT count(*) FROM missing
    WHERE published_at<clock_timestamp()-interval '48 hours'),
  'identity_conflicts',(SELECT count(*) FROM candidates
    WHERE article_id IS NOT NULL AND NOT identity_matches),
  'event_mapping_missing',(SELECT count(*) FROM candidates
    WHERE article_id IS NOT NULL AND identity_matches AND NOT mapped),
  'scope_blockers',(SELECT count(*) FROM candidates c CROSS JOIN registry r
    WHERE left(c.article_url,length(r.entry->>'baseUrl'))
      IS DISTINCT FROM r.entry->>'baseUrl'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.sources) child(value)
        WHERE child.value->>'id' IS DISTINCT FROM 'noaa_news'
          AND length(child.value->>'baseUrl')>length(r.entry->>'baseUrl')
          AND left(c.article_url,length(child.value->>'baseUrl'))
            =child.value->>'baseUrl')),
  'login_roles',(SELECT count(*) FROM projector_roles),
  'valid_logins',(SELECT count(*) FROM projector_roles
    WHERE authorized AND NOT forbidden_access),
  'projector_login',(SELECT min(rolname) FROM projector_roles
    WHERE authorized AND NOT forbidden_access),
  'publication_violations',(SELECT count(*) FROM vns.feed_event_rankings r
    WHERE r.approved_for_publication AND EXISTS (
      SELECT 1 FROM vns.research_event_articles ea
      JOIN vns.research_articles a ON a.article_id=ea.article_id
      WHERE ea.event_id=r.event_id AND a.source_key='noaa_news'))
);
"""

EXPECTED_COUNTS = {
    "candidates": 18,
    "projected": 10,
    "missing": 8,
    "selectable_missing": 8,
    "age_eligible_missing": 0,
    "older_than_48_hours": 8,
    "identity_conflicts": 0,
    "event_mapping_missing": 0,
    "scope_blockers": 0,
    "login_roles": 1,
    "valid_logins": 1,
    "publication_violations": 0,
}


def command(argv: list[str], *, stdin: str | None = None) -> str:
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    try:
        p = subprocess.run(
            argv, input=stdin, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, check=False, timeout=30, env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(DENIED) from None
    if p.returncode != 0 or len(p.stdout) > 16384:
        raise RuntimeError(DENIED)
    return p.stdout.strip()


def require_inode(path: Path, uid: int, gid: int, mode: int, folder: bool) -> None:
    meta = path.lstat()
    if not (
        (stat.S_ISDIR(meta.st_mode) if folder else stat.S_ISREG(meta.st_mode))
        and meta.st_uid == uid and meta.st_gid == gid
        and stat.S_IMODE(meta.st_mode) == mode
        and (folder or meta.st_nlink == 1)
    ):
        raise RuntimeError(DENIED)


def verify_release(sha: str) -> None:
    if os.geteuid() != 0 or not SHA_PATTERN.fullmatch(sha):
        raise RuntimeError(DENIED)
    # Real checkouts may use 0700, 0755 or 0775. Exact 0775 would reject a
    # legitimate ap-owned repository. Reject symlinks and unsafe ownership
    # or permissions instead; .git/index retains its observed strict 0600.
    git_dir = (ROOT / ".git").lstat()
    if (not stat.S_ISDIR(git_dir.st_mode)
        or git_dir.st_uid != 1000 or git_dir.st_gid != 1000
        or stat.S_IMODE(git_dir.st_mode) & 0o002):
        raise RuntimeError(DENIED)
    require_inode(ROOT / ".git/index", 1000, 1000, 0o600, False)
    git = ["git", "--no-optional-locks", "-c", "safe.directory=" + str(ROOT),
           "-C", str(ROOT)]
    if (command(git + ["branch", "--show-current"]) != "main"
        or command(git + ["rev-parse", "HEAD"]) != sha
        or command(git + ["status", "--porcelain"]) != ""
        or command(git + ["rev-parse", "--verify", EXPECTED_WORKER_SHA + "^{commit}"])
            != EXPECTED_WORKER_SHA):
        raise RuntimeError(DENIED)
    command(git + ["diff", "--quiet", EXPECTED_WORKER_SHA, sha, "--",
        "Dockerfile.worker", "apps/worker/src", "apps/worker/package.json",
        "packages/shared", "package-lock.json", "tsconfig.base.json"])


def verify_image_and_runtime() -> None:
    actual = command(["docker", "image", "inspect", EXPECTED_IMAGE,
        "--format", '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}'])
    if actual != EXPECTED_IMAGE_ID + "|" + EXPECTED_WORKER_SHA:
        raise RuntimeError(DENIED)
    if command(["docker", "network", "inspect",
        "videonews-studio_backend", "--format", "{{.Internal}}"]) != "true":
        raise RuntimeError(DENIED)
    # Reject a shadow/incorrect PostgreSQL container even when its name matches.
    database = command(["docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', "videonews-studio-postgres-1"])
    if database != "videonews-studio|postgres|healthy":
        raise RuntimeError(DENIED)
    # A worker using the pinned image must not race this single-source audit.
    running_image = command(["docker", "ps", "--filter",
        "ancestor=" + EXPECTED_IMAGE_ID, "--format", "{{.Names}}"])
    if running_image:
        raise RuntimeError(DENIED)
    names = command(["docker", "ps", "-a", "--format", "{{.Names}}"]).splitlines()
    if (SINGLE_CONTAINER in names
        or any(name.startswith("vns-noaa-project-") for name in names)):
        raise RuntimeError(DENIED)
    running = command(["docker", "ps", "--format",
        '{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project"}}'])
    blocked = {"feed-project-once", "feed-project-continuous",
               "feed-producer", "feed-producer-continuous",
               "feed-consumer", "feed-observer", "feed-scheduler"}
    for line in running.splitlines():
        columns = line.split("|")
        if len(columns) != 3:
            raise RuntimeError(DENIED)
        name, service, project = columns
        if (name.startswith("vns-noaa-project-")
            or project == "videonews-studio" and service in blocked):
            raise RuntimeError(DENIED)
    require_inode(Path("/var/lib/videonews-studio"), 0, 0, 0o700, True)
    require_inode(SECRET_DIR, 0, 0, 0o700, True)
    require_inode(SECRET, 10004, 10004, 0o400, False)


def verify_signed_authority(sha: str) -> None:
    witness = command(["python3", str(ROOT / "scripts" /
        "p2_02_nasa_signed_sql_readonly_witness.py"), "--expected-sha", sha])
    data = json.loads(witness)
    required = ("sql_source_revision_10", "sql_host_revision_10",
       "sql_approved_host_subset_equal_signed", "sql_anchor_digest_matches",
       "sql_trust_policy_matches")
    if (not isinstance(data, dict) or data.get("status") != "parity_reviewable"
        or data.get("feed_started") is not False
        or any(data.get(name) is not True for name in required)):
        raise RuntimeError(DENIED)


def validate_snapshot(data: object) -> dict:
    if not isinstance(data, dict):
        raise RuntimeError(DENIED)
    if any(data.get(key) is not True for key in
           ("read_only", "schema_ready", "source_ready", "host_grant_ready")):
        raise RuntimeError(DENIED)
    if any(type(data.get(key)) is not int or data[key] != expected
           for key, expected in EXPECTED_COUNTS.items()):
        raise RuntimeError(DENIED)
    if data.get("projector_login") != EXPECTED_PROJECTOR_LOGIN:
        raise RuntimeError(DENIED)
    return data


def verify_database() -> dict:
    raw = command(["docker", "exec", "-i", "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 "
        "-c lock_timeout=3000", "videonews-studio-postgres-1",
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews"], stdin=SQL)
    return validate_snapshot(json.loads(raw))


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only NOAA projector preflight")
    parser.add_argument("--preflight", action="store_true", required=True)
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    try:
        verify_release(args.expected_sha)
        verify_image_and_runtime()
        verify_signed_authority(args.expected_sha)
        snapshot = verify_database()
        print(json.dumps({
            "status": "reviewable_no_write", "source_id": "noaa_news",
            "release": args.expected_sha, "image_id": EXPECTED_IMAGE_ID,
            "existing_candidates": snapshot["candidates"],
            "projected_articles": snapshot["projected"],
            "selectable_missing": snapshot["selectable_missing"],
            "missing_age_eligible": snapshot["age_eligible_missing"],
            "git_index_unchanged": True,
            "database_changed": False, "container_created": False,
            "feed_started": False, "projection_authorized": False,
            "publication_authorized": False,
        }, sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError, TypeError,
            json.JSONDecodeError):
        raise SystemExit(DENIED) from None


if __name__ == "__main__":
    main()
