-- P2-02/P2-03: dormant CI-only projection from committed feed candidates.
-- NO runtime grants, logins, network access, scheduler or production activation.
BEGIN;
CREATE ROLE vns_feed_project_executor NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_feed_project_executor;
GRANT SELECT ON vns.feed_poll_candidates TO vns_feed_project_executor;
GRANT SELECT, INSERT ON vns.research_articles, vns.research_events,
  vns.research_event_articles TO vns_feed_project_executor;

CREATE FUNCTION vns.project_feed_candidates(p_source text, p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  candidate record;
  article uuid;
  event_key uuid;
  fingerprint text;
  added integer := 0;
  changed integer;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Feed projection request invalid' USING ERRCODE='22023';
  END IF;
  -- Never promote undated, noncanonical, or future feed metadata.
  -- No verification or publishing authority is inferred from an article.
  FOR candidate IN
    SELECT source_id,article_url,headline,published_at
    FROM vns.feed_poll_candidates
    WHERE source_id=p_source AND review_status='candidate'
      AND published_at IS NOT NULL
      AND published_at <= clock_timestamp()
      AND article_url ~ '^https://[^[:space:]?#]+$'
    ORDER BY article_url LIMIT p_limit
  LOOP
    fingerprint := encode(sha256(convert_to(
      lower(regexp_replace(btrim(candidate.headline),'[[:space:]]+',' ','g')),'UTF8'
    )),'hex');
    article := NULL;
    INSERT INTO vns.research_articles(
      source_key,canonical_url,headline,headline_sha256,published_at
    ) VALUES(
      candidate.source_id,candidate.article_url,candidate.headline,
      fingerprint,candidate.published_at
    )
    ON CONFLICT (canonical_url) DO NOTHING
    RETURNING article_id INTO article;
    IF article IS NULL THEN
      -- Existing canonical URL must match original source, fingerprint and time;
      -- never relabel evidence or overwrite the original provenance.
      SELECT article_id INTO article FROM vns.research_articles
      WHERE canonical_url=candidate.article_url
        AND source_key=candidate.source_id
        AND headline_sha256=fingerprint
        AND published_at=candidate.published_at;
    END IF;
    IF article IS NULL THEN CONTINUE; END IF;
    event_key := NULL;
    INSERT INTO vns.research_events(event_fingerprint,label)
      VALUES(fingerprint,candidate.headline)
      ON CONFLICT (event_fingerprint) DO NOTHING
      RETURNING event_id INTO event_key;
    IF event_key IS NULL THEN
      SELECT event_id INTO event_key FROM vns.research_events
      WHERE event_fingerprint=fingerprint;
    END IF;
    IF event_key IS NULL THEN
      RAISE EXCEPTION 'Feed projection event not available' USING ERRCODE='23503';
    END IF;
    INSERT INTO vns.research_event_articles(event_id,article_id)
      VALUES(event_key,article)
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    added := added + changed;
  END LOOP;
  RETURN added;
END;
$body$;

REVOKE ALL ON FUNCTION vns.project_feed_candidates(text,integer) FROM PUBLIC;
ALTER FUNCTION vns.project_feed_candidates(text,integer) OWNER TO vns_feed_project_executor;
-- Only this NOLOGIN owner can run the function in disposable CI.
-- No EXECUTE granted to API, running worker, feed polling role or PUBLIC.
INSERT INTO vns.schema_migrations(version) VALUES ('0028_feed_candidate_projection');
COMMIT;
