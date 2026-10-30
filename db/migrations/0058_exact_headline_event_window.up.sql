-- P2-A 0058: exact-fingerprint matches obey the 48-hour all-member gate.
-- No existing article, event, or immutable review is rewritten.
BEGIN;
CREATE OR REPLACE FUNCTION vns.project_feed_candidates(p_source text, p_limit integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  candidate record;
  article uuid;
  event_key uuid;
  fingerprint text;
  v_event_digest text;
  added integer := 0;
  changed integer;
  matching_count integer;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Feed projection request invalid' USING ERRCODE='22023';
  END IF;
  -- All source projectors use one short transaction-level advisory lock
  -- for event grouping. Without serialization, two concurrently ingested
  -- rewritten headlines could create separate events on different sources.
  -- This does not authorize or alter the source/host approval gates.
  PERFORM pg_advisory_xact_lock(721214, 52);
  -- Never promote undated, noncanonical, or future feed metadata.
  -- No verification or publishing authority is inferred from an article.
  FOR candidate IN
    SELECT feed.source_id,feed.article_url,feed.headline,feed.published_at
    FROM vns.feed_poll_candidates AS feed
    LEFT JOIN vns.research_articles AS prior
      ON prior.canonical_url=feed.article_url
    LEFT JOIN vns.research_event_articles AS mapped
      ON mapped.article_id=prior.article_id
    WHERE feed.source_id=p_source AND feed.review_status='candidate'
      AND feed.published_at IS NOT NULL
      AND feed.published_at <= clock_timestamp()
      AND feed.article_url ~ '^https://[^[:space:]?#]+$'
      AND mapped.article_id IS NULL
    ORDER BY feed.article_url LIMIT p_limit
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
    -- Reusing an exact fingerprint must obey the SAME +/-48-hour bound
    -- as conservative near-duplicate matches, for every existing member.
    -- A title may recur months later without being the same event.
    SELECT e.event_id INTO event_key FROM vns.research_events e
    WHERE e.event_fingerprint=fingerprint
      AND EXISTS(
        SELECT 1 FROM vns.research_event_articles ea
        WHERE ea.event_id=e.event_id
      )
      AND NOT EXISTS(
        SELECT 1 FROM vns.research_event_articles ea
        JOIN vns.research_articles a ON a.article_id=ea.article_id
        WHERE ea.event_id=e.event_id
          AND (a.published_at IS NULL OR
               abs(extract(epoch FROM
                 (candidate.published_at-a.published_at)))>172800)
      );
    IF event_key IS NULL THEN
      -- Conservative rewritten-syndication match. Every existing member
      -- must be similar and within +/-48 hours; ambiguous candidates
      -- stay separate instead of silently merging different stories.
      SELECT count(*)::integer,min(v.event_id::text)::uuid
        INTO matching_count,event_key
      FROM (
        SELECT e.event_id
        FROM vns.research_events e
        WHERE EXISTS(
          SELECT 1 FROM vns.research_event_articles ea
          WHERE ea.event_id=e.event_id
        )
        AND NOT EXISTS(
          SELECT 1 FROM vns.research_event_articles ea
          JOIN vns.research_articles a ON a.article_id=ea.article_id
          WHERE ea.event_id=e.event_id
            AND (a.published_at IS NULL
                 OR abs(extract(epoch FROM
                  (candidate.published_at-a.published_at)))>172800
                 OR NOT vns.rank_headlines_overlap(candidate.headline,a.headline))
        )
        ORDER BY e.event_id LIMIT 2
      ) v;
      IF matching_count<>1 THEN event_key:=NULL; END IF;
    END IF;
    IF event_key IS NULL THEN
      -- Preserve the article evidence fingerprint; event identity must be
      -- distinct when a historical event already owns the exact digest.
      -- The canonical URL is immutable and scoped to the approved source.
      -- Advisory lock above serializes competing feed projectors.
      v_event_digest:=fingerprint;
      IF EXISTS(
        SELECT 1 FROM vns.research_events e
        WHERE e.event_fingerprint=fingerprint
      ) THEN
        v_event_digest:=encode(sha256(convert_to(
          'event-window-v1:'||fingerprint||E'\\n'||
          candidate.source_id||E'\\n'||candidate.article_url,'UTF8'
        )),'hex');
      END IF;
      INSERT INTO vns.research_events(event_fingerprint,label)
        VALUES(v_event_digest,candidate.headline)
        ON CONFLICT (event_fingerprint) DO NOTHING
        RETURNING event_id INTO event_key;
      IF event_key IS NULL THEN
        SELECT e.event_id INTO event_key FROM vns.research_events e
        WHERE e.event_fingerprint=v_event_digest;
      END IF;
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
INSERT INTO vns.schema_migrations(version)
  VALUES('0058_exact_headline_event_window');
COMMIT;
