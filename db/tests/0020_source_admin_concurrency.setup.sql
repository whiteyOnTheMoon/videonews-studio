-- Disposable persistent fixture for two independent, racing sessions.
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES ('ca110003-3333-4333-8333-333333333333','ci_source_racer',
  'CI Source Race Admin','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
