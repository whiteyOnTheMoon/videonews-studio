-- Offline-only destructive migration. Never run against production.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version = '0003_research_requests';
DROP FUNCTION vns.create_research_request(text, text);
DROP TABLE vns.research_requests;
COMMIT;
