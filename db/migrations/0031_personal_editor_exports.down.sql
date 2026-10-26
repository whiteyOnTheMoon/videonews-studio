-- Disposable CI-only rollback. Do not erase production editorial history.
BEGIN;
DROP FUNCTION vns.named_timeline_page(uuid,timestamptz,uuid,integer);
DROP FUNCTION vns.named_current_editor();
REVOKE SELECT ON vns.editorial_timeline FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0031_personal_editor_exports';
COMMIT;
