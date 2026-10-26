-- P2-10 offline-only immutable editorial decision ledger foundation.
BEGIN;
CREATE TABLE vns.editorial_timeline (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES vns.stories(id) ON DELETE RESTRICT,
  event_kind text NOT NULL CHECK (event_kind IN
    ('source', 'claim', 'claim_rejected', 'review', 'script_revision', 'decision')),
  actor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  reference_uri text CHECK (reference_uri IS NULL OR
    (length(reference_uri) <= 2048 AND reference_uri ~ '^https://[^[:space:]]+$')),
  document_sha256 text CHECK (document_sha256 IS NULL OR
    document_sha256 ~ '^[0-9a-f]{64}$'),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'
    AND octet_length(details::text) <= 8192),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX editorial_timeline_story_time_idx
  ON vns.editorial_timeline(story_id, recorded_at, event_id);
CREATE FUNCTION vns.refuse_editorial_timeline_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'editorial timeline is append-only' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER editorial_timeline_no_update
  BEFORE UPDATE OR DELETE ON vns.editorial_timeline
  FOR EACH ROW EXECUTE FUNCTION vns.refuse_editorial_timeline_mutation();
REVOKE ALL ON vns.editorial_timeline FROM PUBLIC;
-- No INSERT grants; privileged, personal and audited write API must be implemented separately.
INSERT INTO vns.schema_migrations(version) VALUES('0024_editorial_timeline');
COMMIT;
