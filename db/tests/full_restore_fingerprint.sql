-- Deterministic data digest across every ordinary vns table. Synthetic CI only.
-- Stable JSONB serialization avoids depending on heap insertion order.
CREATE TEMP TABLE ci_full_restore_fingerprints(
 table_name text PRIMARY KEY,
 row_count bigint NOT NULL,
 digest text NOT NULL
) ON COMMIT PRESERVE ROWS;

DO $fingerprint$
DECLARE
  rel record;
  n bigint;
  hash text;
BEGIN
  FOR rel IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname='vns' AND c.relkind='r'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, %L ORDER BY to_jsonb(t)::text), %L)) FROM vns.%I t',
      '|','', rel.relname
    ) INTO n,hash;
    INSERT INTO ci_full_restore_fingerprints VALUES (rel.relname,n,hash);
  END LOOP;
END;
$fingerprint$;

SELECT md5(string_agg(table_name || ':' || row_count::text || ':' || digest,
                       E'\n' ORDER BY table_name))
FROM ci_full_restore_fingerprints;
