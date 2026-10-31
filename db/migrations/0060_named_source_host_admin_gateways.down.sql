-- CI-only rollback of 0060. Never use for production rollback.
BEGIN;
DROP FUNCTION vns.named_host_change(bigint,bigint,text,text,text);
DROP FUNCTION vns.named_source_commit(bigint,bigint,jsonb,text,text);
DROP FUNCTION vns.named_host_read();
DROP FUNCTION vns.named_source_read();
DROP FUNCTION vns.named_source_actor();
REVOKE SELECT ON vns.admin_source_registry,
  vns.admin_source_host_approvals FROM vns_p2_named_executor;
REVOKE EXECUTE ON FUNCTION vns.admin_commit_source_registry(
  bigint,bigint,jsonb,text,text,uuid,integer,timestamptz),
  vns.admin_change_source_host_approval(
    bigint,bigint,text,text,text,uuid,integer)
  FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations
  WHERE version='0060_named_source_host_admin_gateways';
COMMIT;
