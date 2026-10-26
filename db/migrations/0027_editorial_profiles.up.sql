-- P2-09 dormant revisioned profile registry and mutation audit. No EXECUTE grants.
BEGIN;
CREATE TABLE vns.editorial_profile_registry (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
 profiles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
   jsonb_typeof(profiles)='array'
   AND jsonb_array_length(profiles) <= 20
   AND octet_length(profiles::text) <= 32768
 )
);
INSERT INTO vns.editorial_profile_registry(singleton,revision,profiles)
VALUES(true,0,'[]'::jsonb);
CREATE TABLE vns.editorial_profile_audit (
 revision bigint PRIMARY KEY CHECK(revision > 0),
 actor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
 previous_sha256 text NOT NULL CHECK(previous_sha256 ~ '^[0-9a-f]{64}$'),
 current_sha256 text NOT NULL CHECK(current_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION vns.commit_editorial_profiles(
 p_expected bigint,p_next jsonb,p_actor uuid,p_auth_version integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE old_profiles jsonb; old_revision bigint;
BEGIN
 IF p_expected IS NULL OR p_expected < 0 OR p_next IS NULL
 OR jsonb_typeof(p_next) <> 'array'
 OR jsonb_array_length(p_next) > 20
 OR octet_length(p_next::text) > 32768 OR p_actor IS NULL
 OR p_auth_version IS NULL OR p_auth_version < 0
 THEN RAISE EXCEPTION 'profile mutation invalid' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM vns.editor_accounts
 WHERE id=p_actor AND active=true AND role='admin'
 AND auth_version=p_auth_version FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile editor forbidden' USING ERRCODE='42501'; END IF;
 SELECT revision,profiles INTO old_revision,old_profiles
 FROM vns.editorial_profile_registry WHERE singleton=true FOR UPDATE;
 IF NOT FOUND OR old_revision<>p_expected THEN RETURN false; END IF;
 IF old_revision=9223372036854775807 THEN RETURN false; END IF;
 UPDATE vns.editorial_profile_registry
 SET revision=old_revision+1,profiles=p_next WHERE singleton=true;
 INSERT INTO vns.editorial_profile_audit(
  revision,actor_id,previous_sha256,current_sha256)
 VALUES(old_revision+1,p_actor,
  encode(sha256(convert_to(old_profiles::text,'UTF8')),'hex'),
  encode(sha256(convert_to(p_next::text,'UTF8')),'hex'));
 RETURN true;
END;
$body$;
REVOKE ALL ON vns.editorial_profile_registry,vns.editorial_profile_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.commit_editorial_profiles(bigint,jsonb,uuid,integer) FROM PUBLIC;
INSERT INTO vns.schema_migrations(version) VALUES('0027_editorial_profiles');
COMMIT;
