-- Disposable migration-cycle assertions; real LOGIN test is separate.
DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN
      ('vns_operator_governor','vns_operator_registry_executor')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole)
  ) OR (
    SELECT count(*) FROM pg_roles WHERE rolname IN
      ('vns_operator_governor','vns_operator_registry_executor')
  )<>2 THEN
    RAISE EXCEPTION 'Registry roles must be present and inert';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members WHERE roleid IN
      (SELECT oid FROM pg_roles WHERE rolname IN
       ('vns_operator_governor','vns_operator_registry_executor'))
  ) THEN
    RAISE EXCEPTION 'Governance migration must not enroll members';
  END IF;
  IF has_table_privilege('vns_operator_governor',
       'vns.editor_operator_registry','UPDATE')
     OR has_table_privilege('vns_operator_governor',
       'vns.editor_operator_registry_events','INSERT')
     OR has_function_privilege('vns_editor_provisioner',
       'vns.register_editor_operator(name,uuid,text,text)','EXECUTE')
     OR has_function_privilege('vns_api_runtime',
       'vns.revoke_editor_operator(name,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Unauthorized registry management grants';
  END IF;
END;
$assert$;

-- A synthetic LOGIN has no credentials and can never authenticate externally.
CREATE ROLE vns_ci_registry_subject LOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT vns_editor_provisioner TO vns_ci_registry_subject;

SET ROLE vns_operator_governor;
DO $deny$
BEGIN
  BEGIN
    INSERT INTO vns.editor_operator_registry
      (login_role,operator_id,operator_label)
    VALUES ('vns_ci_registry_subject',
      'dddddddd-1234-4123-8123-dddddddddddd','Forged Operator');
    RAISE EXCEPTION 'Governance role wrote registry directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM vns.register_editor_operator('vns_ci_registry_subject',
      'dddddddd-1234-4123-8123-dddddddddddd','CI Test Operator','too short');
    RAISE EXCEPTION 'Missing justification was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM vns.register_editor_operator('vns',
      'dddddddd-1234-4123-8123-dddddddddddd','CI Test Operator',
      'This is a synthetic, deliberately forbidden owner enrollment.');
    RAISE EXCEPTION 'Privileged owner was enrolled';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$deny$;
SELECT vns.register_editor_operator('vns_ci_registry_subject',
  'dddddddd-1234-4123-8123-dddddddddddd','CI Governance Subject',
  'Synthetic operator enrollment explicitly approved for disposable CI.');
DO $duplicate$
BEGIN
  BEGIN
    PERFORM vns.register_editor_operator('vns_ci_registry_subject',
      'eeeeeeee-1234-4123-8123-eeeeeeeeeeee','Duplicate Operator',
      'Duplicate enrollment must never replace identity in the registry.');
    RAISE EXCEPTION 'Duplicate registry enrollment accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$duplicate$;
SELECT vns.revoke_editor_operator('vns_ci_registry_subject',
  'CI test revocation after simulated end of operator authorization.');
DO $double$
BEGIN
  BEGIN
    PERFORM vns.revoke_editor_operator('vns_ci_registry_subject',
      'Repeat operator revocation must not produce another audit event.');
    RAISE EXCEPTION 'Repeated revocation was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$double$;
RESET ROLE;

DO $check_events$
BEGIN
  IF EXISTS (SELECT 1 FROM vns.editor_operator_registry
             WHERE login_role='vns_ci_registry_subject' AND active=true)
     OR (SELECT count(*) FROM vns.editor_operator_registry_events
          WHERE login_role='vns_ci_registry_subject')<>2
     OR (SELECT count(*) FROM vns.editor_operator_registry_events
          WHERE login_role='vns_ci_registry_subject'
            AND authorized_by=session_user)<>2 THEN
    RAISE EXCEPTION 'Registry governance events missing or mismatched';
  END IF;
  BEGIN
    DELETE FROM vns.editor_operator_registry_events;
    RAISE EXCEPTION 'Registry audit entries were deletable';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$check_events$;
REVOKE vns_editor_provisioner FROM vns_ci_registry_subject;
DROP ROLE vns_ci_registry_subject;
