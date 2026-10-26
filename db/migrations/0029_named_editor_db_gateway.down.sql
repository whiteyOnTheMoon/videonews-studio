-- Disposable CI rollback only; no production identity/ledger deletion authorized.
BEGIN;
DROP FUNCTION vns.named_timeline_read(uuid,integer);
DROP FUNCTION vns.named_timeline_append(uuid,text,text,text,jsonb);
DROP FUNCTION vns.named_profile_read();
DROP FUNCTION vns.named_profile_commit(bigint,jsonb);
REVOKE EXECUTE ON FUNCTION vns.commit_editorial_profiles(bigint,jsonb,uuid,integer),
  vns.append_editorial_timeline(uuid,text,uuid,integer,text,text,jsonb),
  vns.read_editorial_timeline(uuid,uuid,integer,integer)
  FROM vns_p2_named_executor;
REVOKE SELECT ON vns.editor_db_principals,
  vns.editorial_profile_registry FROM vns_p2_named_executor;
REVOKE SELECT(id,active,role,auth_version) ON vns.editor_accounts
  FROM vns_p2_named_executor;
DROP TABLE vns.editor_db_principals;
REVOKE USAGE ON SCHEMA vns FROM vns_p2_named_client,vns_p2_named_executor;
DROP ROLE vns_p2_named_client;
DROP ROLE vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0029_named_editor_db_gateway';
COMMIT;
