-- For disposable CI rollback only. No production data removal authorized.
BEGIN;
DROP TABLE vns.research_claim_evidence;
DROP TABLE vns.research_claims;
DROP TABLE vns.research_event_articles;
DROP TABLE vns.research_events;
DROP TABLE vns.research_articles;
DELETE FROM vns.schema_migrations WHERE version='0026_editorial_research_persistence';
COMMIT;
