-- P2-04 extension: original article links for private editorial verification.
-- Preserve the existing 0063 function and unchanged source/host policy.
-- No live feed requests, table modifications or publishing permissions.
-- No source authorization, event, ranking or publication flags are changed.
BEGIN;
GRANT SELECT ON vns.feed_poll_candidates TO vns_p2_named_executor;

CREATE FUNCTION vns.named_feed_inbox_sources_page(p_limit integer)
RETURNS TABLE(
  source_id text,article_url text,headline text,published_at timestamptz,projected boolean,
  event_id uuid,approved_for_publication boolean
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.editor_db_principals p
    JOIN vns.editor_accounts a ON a.id=p.editor_id
    WHERE p.login_role=session_user AND p.active=true AND a.active=true
      AND a.auth_version=p.auth_version AND a.role='admin'
  ) THEN
    RAISE EXCEPTION 'Personal feed inbox forbidden' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'Feed inbox page limit invalid' USING ERRCODE='22023';
  END IF;

  -- Every read rechecks current registered source/host rights and URL scopes.
  -- The existing authority function uses shared locks; do not run in a
  -- transaction declared read-only, unlike stand-alone aggregate witnesses.
  RETURN QUERY
  SELECT c.source_id,c.article_url,c.headline,c.published_at,
    mapped.event_id IS NOT NULL,mapped.event_id,false
  FROM (
    SELECT feed.source_id,feed.article_url,feed.headline,feed.published_at
    FROM vns.feed_poll_candidates feed
    JOIN vns.admin_source_registry registry ON registry.singleton=true
    JOIN LATERAL jsonb_array_elements(registry.sources) src(value)
      ON src.value->>'id'=feed.source_id
    WHERE feed.review_status='candidate'
      AND feed.published_at IS NOT NULL
      AND feed.published_at<=clock_timestamp()
      AND length(feed.headline) BETWEEN 8 AND 500
      AND feed.headline !~ '[<>[:cntrl:]]'
      AND feed.article_url ~ '^https://[^[:space:]?#]+$'
      AND src.value->>'status'='approved'
      AND left(feed.article_url,length(src.value->>'baseUrl'))
        =src.value->>'baseUrl'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(registry.sources) child(value)
        WHERE child.value->>'id' IS DISTINCT FROM feed.source_id
          AND length(child.value->>'baseUrl')>length(src.value->>'baseUrl')
          AND left(feed.article_url,length(child.value->>'baseUrl'))
            =child.value->>'baseUrl'
      )
      AND vns.feed_runtime_source_authorized(src.value)
    ORDER BY feed.published_at DESC,feed.article_url
    LIMIT p_limit
  ) c
  LEFT JOIN LATERAL (
    SELECT ea.event_id
    FROM vns.research_articles a
    JOIN vns.research_event_articles ea ON ea.article_id=a.article_id
    WHERE a.canonical_url=c.article_url
      AND a.source_key=c.source_id
      AND a.headline=c.headline
      AND a.published_at=c.published_at
    ORDER BY ea.event_id LIMIT 1
  ) mapped ON true
  ORDER BY c.published_at DESC,c.article_url;
END;
$body$;

REVOKE ALL ON FUNCTION vns.named_feed_inbox_sources_page(integer) FROM PUBLIC;
ALTER FUNCTION vns.named_feed_inbox_sources_page(integer) OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_feed_inbox_sources_page(integer)
  TO vns_p2_named_client;

INSERT INTO vns.schema_migrations(version) VALUES('0065_named_feed_inbox_sources');
COMMIT;
