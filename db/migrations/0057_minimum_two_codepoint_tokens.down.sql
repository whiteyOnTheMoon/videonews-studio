-- Restore the previous function definition only. Evidence remains intact.
BEGIN;
CREATE OR REPLACE FUNCTION vns.rank_headlines_overlap(p_left text,p_right text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog
AS $overlap$
  WITH sets AS (
    SELECT ARRAY(
      SELECT DISTINCT word
      FROM unnest(string_to_array(vns.rank_nfkc_words(p_left),' ')) AS w(word)
      WHERE word<>''
    ) AS a,
    ARRAY(
      SELECT DISTINCT word
      FROM unnest(string_to_array(vns.rank_nfkc_words(p_right),' ')) AS w(word)
      WHERE word<>''
    ) AS b
  ), counts AS (
    SELECT cardinality(a) AS na, cardinality(b) AS nb,
      (SELECT count(*)::integer FROM unnest(a) AS w(word)
       WHERE word=ANY(b)) AS common
    FROM sets
  )
  SELECT COALESCE(na>=6 AND nb>=6 AND common>=6
    AND common*5 >= (na+nb-common)*4,false) FROM counts;
$overlap$;
DELETE FROM vns.schema_migrations WHERE version='0057_minimum_two_codepoint_tokens';
COMMIT;
