BEGIN;
DROP FUNCTION vns.ack_provider_outbox_delivery(uuid);
DROP FUNCTION vns.read_authorized_provider_outbox(integer);
DROP TABLE vns.provider_named_job_delivery_receipts;
REVOKE SELECT(id,kind,status,max_attempts) ON vns.jobs
 FROM vns_provider_outbox_executor;
REVOKE SELECT(id,role,active,auth_version) ON vns.editor_accounts
 FROM vns_provider_outbox_executor;
REVOKE SELECT(id,provider,model,expires_at) ON vns.provider_live_price_snapshots
 FROM vns_provider_outbox_executor;
REVOKE ALL ON vns.provider_named_job_authorizations,
 vns.provider_named_job_sealed_prompts,vns.provider_named_job_outbox
 FROM vns_provider_outbox_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_provider_outbox_reader,vns_provider_outbox_executor;
DROP ROLE vns_provider_outbox_reader;
DROP ROLE vns_provider_outbox_executor;
DELETE FROM vns.schema_migrations
 WHERE version='0048_provider_outbox_delivery_receipt';
COMMIT;
