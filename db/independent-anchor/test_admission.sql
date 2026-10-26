\set ON_ERROR_STOP on
CREATE ROLE vns_anchor_ci_owner NOLOGIN;
CREATE ROLE vns_anchor_ci_worker NOLOGIN;
ALTER SCHEMA vns_source_anchor OWNER TO vns_anchor_ci_owner;
ALTER TABLE vns_source_anchor.high_water OWNER TO vns_anchor_ci_owner;
ALTER FUNCTION vns_source_anchor.advance(bigint,bigint,text) OWNER TO vns_anchor_ci_owner;
GRANT USAGE ON SCHEMA vns_source_anchor TO vns_anchor_ci_worker;
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance(bigint,bigint,text) TO vns_anchor_ci_worker;
INSERT INTO vns_source_anchor.high_water VALUES ('source-export',8,3,repeat('a',64));
DO $$
BEGIN
 IF has_table_privilege('vns_anchor_ci_worker','vns_source_anchor.high_water','UPDATE')
   OR has_table_privilege('vns_anchor_ci_worker','vns_source_anchor.high_water','INSERT')
   OR has_table_privilege('vns_anchor_ci_worker','vns_source_anchor.high_water','DELETE')
   OR has_function_privilege('public','vns_source_anchor.advance(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'insecure authority grants'; END IF;
END $$;
SET ROLE vns_anchor_ci_worker;
DO $$
BEGIN
 IF NOT vns_source_anchor.advance(8,3,repeat('a',64))
 OR vns_source_anchor.advance(8,3,repeat('b',64))
 OR vns_source_anchor.advance(7,4,repeat('a',64))
 OR vns_source_anchor.advance(9,2,repeat('a',64))
 OR NOT vns_source_anchor.advance(9,4,repeat('c',64))
 OR vns_source_anchor.advance(9,4,repeat('d',64))
 OR vns_source_anchor.advance(8,3,repeat('a',64))
 THEN RAISE EXCEPTION 'monotonic admission failed'; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
 IF (SELECT source_revision FROM vns_source_anchor.high_water) <> 9
 OR (SELECT host_approval_revision FROM vns_source_anchor.high_water) <> 4
 OR (SELECT envelope_sha256 FROM vns_source_anchor.high_water) <> repeat('c',64)
 THEN RAISE EXCEPTION 'unexpected state'; END IF;
END $$;
