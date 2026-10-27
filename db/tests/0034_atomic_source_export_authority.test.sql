-- P2-01: disposable SQL-only privilege, unavailable audit and rollback tests.
BEGIN;
DO $acl$
BEGIN
  IF has_table_privilege('vns_source_export_reader','vns.admin_source_registry','SELECT')
    OR has_table_privilege('vns_source_export_reader',
                          'vns.admin_source_host_approvals','SELECT')
    OR has_table_privilege('vns_source_export_reader',
                          'vns.admin_source_host_audit','SELECT')
    OR NOT has_function_privilege('vns_source_export_reader',
                                 'vns.read_approved_source_export()','EXECUTE')
    OR has_function_privilege('vns_feed_poll_writer',
                              'vns.read_approved_source_export()','EXECUTE')
    OR has_function_privilege('vns_api_runtime',
                              'vns.read_approved_source_export()','EXECUTE')
  THEN RAISE EXCEPTION 'Source-export privilege separation failed'; END IF;
END $acl$;

SET LOCAL ROLE vns_source_export_reader;
DO $empty$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM vns.read_approved_source_export();
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Empty approval set exported'; END IF;
  denied := false;
  BEGIN
    PERFORM sources FROM vns.admin_source_registry;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Direct source-table read exposed'; END IF;
END $empty$;
RESET ROLE;

-- Manually supplied host grants without their append-only audit are NOT
-- trustworthy even if their in-memory singleton row says approved.
UPDATE vns.admin_source_registry SET revision=1,
  sources='[{"id":"ci_snapshot_rss","baseUrl":"https://snapshot.example.org/rss/",
  "access":"rss","intervalMinutes":60,"termsUrl":"https://snapshot.example.org/terms/",
  "usage":"metadata_only","licenseNotes":"Synthetic read-only fixture.","status":"approved",
  "reviewedAt":"2026-10-26"}]'::jsonb WHERE singleton=true;
UPDATE vns.admin_source_host_approvals SET revision=1,
  approved_hosts='["snapshot.example.org"]'::jsonb WHERE singleton=true;
SET LOCAL ROLE vns_source_export_reader;
DO $unaudited$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM vns.read_approved_source_export();
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unproven host approval was exported'; END IF;
END $unaudited$;
RESET ROLE;
ROLLBACK;
