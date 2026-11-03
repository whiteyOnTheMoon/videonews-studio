\set ON_ERROR_STOP on
-- External, independently administered PostgreSQL authority ONLY.
-- Run as a separately authenticated authority operator, never on the
-- application database. No writes, grants, worker execution or bootstrap.
-- All expected_* psql variables must be supplied explicitly. Missing values
-- fail before any report can return PASS.
BEGIN TRANSACTION READ ONLY;
WITH runtime_role AS (
  SELECT oid, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
         rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles
   WHERE rolname = :'expected_runtime_login'
),
candidate AS (
  SELECT :'expected_database'::text AS db,
         :'expected_runtime_login'::text AS login,
         :'expected_source_revision'::text AS source_text,
         :'expected_host_revision'::text AS host_text,
         :'expected_envelope_sha256'::text AS envelope,
         :'expected_policy_revision'::text AS policy_text,
         :'expected_policy_sha256'::text AS policy
)
SELECT (
  current_database() = (SELECT db FROM candidate)
  AND session_user <> (SELECT login FROM candidate)
  AND current_setting('server_version_num')::integer >= 170000
  AND (SELECT source_text ~ '^[1-9][0-9]{0,14}$' FROM candidate)
  AND (SELECT host_text ~ '^[1-9][0-9]{0,14}$' FROM candidate)
  AND (SELECT policy_text ~ '^[1-9][0-9]{0,14}$' FROM candidate)
  AND (SELECT envelope ~ '^[0-9a-f]{64}$' FROM candidate)
  AND (SELECT policy ~ '^[0-9a-f]{64}$' FROM candidate)
  AND (SELECT login ~ '^vns_anchor_login_[a-z0-9_]{3,24}$' FROM candidate)
  AND (SELECT count(*) = 1
         FROM vns_source_anchor.high_water a, candidate c
        WHERE a.anchor_id = 'source-export'
          AND a.source_revision = c.source_text::bigint
          AND a.host_approval_revision = c.host_text::bigint
          AND a.envelope_sha256 = c.envelope)
  AND (SELECT count(*) = 1
         FROM vns_source_anchor.trust_policy_high_water a, candidate c
        WHERE a.singleton IS TRUE
          AND a.policy_revision = c.policy_text::bigint
          AND a.policy_sha256 = c.policy)
  AND (SELECT count(*) = 1
         FROM vns_source_anchor.trust_policy_approvals a, candidate c
        WHERE a.policy_revision = c.policy_text::bigint
          AND a.policy_sha256 = c.policy)
  AND (SELECT count(*) = 1
         FROM runtime_role r
        WHERE r.rolcanlogin
          AND NOT r.rolsuper AND NOT r.rolcreaterole
          AND NOT r.rolcreatedb AND NOT r.rolreplication
          AND NOT r.rolbypassrls)
  AND has_schema_privilege((SELECT login FROM candidate), 'vns_source_anchor', 'USAGE') IS TRUE
  AND has_function_privilege(
        (SELECT login FROM candidate),
        'vns_source_anchor.advance(bigint,bigint,text)', 'EXECUTE'
      ) IS TRUE
  AND has_function_privilege(
        (SELECT login FROM candidate),
        'vns_source_anchor.advance_trust_policy(bigint,text)', 'EXECUTE'
      ) IS TRUE
  AND (SELECT count(*) = 3 AND bool_and(NOT owner.rolcanlogin)
         FROM pg_catalog.pg_class t
         JOIN pg_catalog.pg_roles owner ON owner.oid = t.relowner
        WHERE t.oid IN (
          'vns_source_anchor.high_water'::regclass,
          'vns_source_anchor.trust_policy_high_water'::regclass,
          'vns_source_anchor.trust_policy_approvals'::regclass
        ))
  AND (SELECT count(*) = 2
          AND bool_and(
            p.prosecdef
            AND NOT owner.rolcanlogin
            AND 'search_path=pg_catalog' = ANY(p.proconfig)
          )
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
        WHERE p.oid IN (
          'vns_source_anchor.advance(bigint,bigint,text)'::regprocedure,
          'vns_source_anchor.advance_trust_policy(bigint,text)'::regprocedure
        ))
  AND NOT EXISTS (
    SELECT 1
      FROM runtime_role r
      CROSS JOIN (
        SELECT t.relowner AS authority_owner
          FROM pg_catalog.pg_class t
         WHERE t.oid IN (
           'vns_source_anchor.high_water'::regclass,
           'vns_source_anchor.trust_policy_high_water'::regclass,
           'vns_source_anchor.trust_policy_approvals'::regclass
         )
        UNION
        SELECT p.proowner
          FROM pg_catalog.pg_proc p
         WHERE p.oid IN (
           'vns_source_anchor.advance(bigint,bigint,text)'::regprocedure,
           'vns_source_anchor.advance_trust_policy(bigint,text)'::regprocedure
         )
      ) owners
     WHERE pg_has_role(r.oid, owners.authority_owner, 'MEMBER')
  )
  AND has_table_privilege(
        (SELECT login FROM candidate),
        'vns_source_anchor.high_water',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) IS FALSE
  AND has_table_privilege(
        (SELECT login FROM candidate),
        'vns_source_anchor.trust_policy_high_water',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) IS FALSE
  AND has_table_privilege(
        (SELECT login FROM candidate),
        'vns_source_anchor.trust_policy_approvals',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) IS FALSE
) AS vns_anchor_attested
\gset
ROLLBACK;
\if :vns_anchor_attested
\echo PASS: independent authority stored state and runtime grants match expected candidate
\else
\echo REFUSED: independent authority state or runtime grants do not match
-- Deliberate nonzero psql exit with ON_ERROR_STOP; no database writes.
SELECT 1 / 0;
\endif
