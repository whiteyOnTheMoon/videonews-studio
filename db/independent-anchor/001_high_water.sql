-- Separate authority database ONLY: never apply this as a normal app migration.
-- Operator-provisioned bootstrap is mandatory before connecting any worker.
-- Provision dedicated roles, transport security, immutable audit and recovery
-- outside the publisher/worker administration and rollback domain.
BEGIN;
CREATE SCHEMA IF NOT EXISTS vns_source_anchor;
REVOKE ALL ON SCHEMA vns_source_anchor FROM PUBLIC;
CREATE TABLE IF NOT EXISTS vns_source_anchor.high_water (
  anchor_id text PRIMARY KEY CHECK (anchor_id = 'source-export'),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  host_approval_revision bigint NOT NULL CHECK (host_approval_revision >= 0),
  envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON vns_source_anchor.high_water FROM PUBLIC;
-- Deliberately no INSERT, DELETE, TRUNCATE, ALTER or role grant here.
-- An independently authenticated operator must bootstrap one signed,
-- approved initial state and grant only UPDATE/SELECT needed by the
-- compare-and-advance writer. See accompanying operational runbook.
COMMIT;
