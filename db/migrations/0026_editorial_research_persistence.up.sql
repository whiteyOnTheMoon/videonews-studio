-- Offline-only P2-03 to P2-05 persistence foundation. No runtime grants.
BEGIN;
CREATE TABLE vns.research_articles (
  article_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL CHECK (source_key ~ '^[a-z][a-z0-9_-]{2,40}$'),
  canonical_url text NOT NULL UNIQUE CHECK (
    length(canonical_url) BETWEEN 18 AND 2048
    AND canonical_url ~ '^https://[^[:space:]?#]+$'
  ),
  headline text NOT NULL CHECK (length(headline) BETWEEN 8 AND 200),
  headline_sha256 text NOT NULL CHECK (headline_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (published_at <= discovered_at + interval '1 day')
);
CREATE INDEX research_articles_fingerprint_idx
 ON vns.research_articles(headline_sha256,published_at);
CREATE TABLE vns.research_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_fingerprint text NOT NULL UNIQUE CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
 label text NOT NULL CHECK (length(label) BETWEEN 8 AND 200),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE vns.research_event_articles (
 event_id uuid NOT NULL REFERENCES vns.research_events(event_id) ON DELETE RESTRICT,
 article_id uuid NOT NULL REFERENCES vns.research_articles(article_id) ON DELETE RESTRICT,
 PRIMARY KEY(event_id,article_id),
 UNIQUE(article_id)
);
CREATE TABLE vns.research_claims (
 claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id uuid NOT NULL REFERENCES vns.research_events(event_id) ON DELETE RESTRICT,
 statement text NOT NULL CHECK (length(statement) BETWEEN 8 AND 2000),
 verification_status text NOT NULL DEFAULT 'unverified'
   CHECK (verification_status IN ('unverified','disputed','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(claim_id,event_id)
);
CREATE TABLE vns.research_claim_evidence (
 claim_id uuid NOT NULL REFERENCES vns.research_claims(claim_id) ON DELETE RESTRICT,
 article_id uuid NOT NULL REFERENCES vns.research_articles(article_id) ON DELETE RESTRICT,
 reference_url text NOT NULL CHECK (
   length(reference_url) BETWEEN 18 AND 2048
   AND reference_url ~ '^https://[^[:space:]?#]+$'
 ),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(claim_id,article_id)
);
REVOKE ALL ON vns.research_articles,vns.research_events,
 vns.research_event_articles,vns.research_claims,vns.research_claim_evidence FROM PUBLIC;
-- No active ingestion, AI, scheduler, API or worker writes are granted.
INSERT INTO vns.schema_migrations(version) VALUES('0026_editorial_research_persistence');
COMMIT;
