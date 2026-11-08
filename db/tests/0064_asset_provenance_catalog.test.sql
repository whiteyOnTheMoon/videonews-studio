-- P3-01: tests are disposable, offline, and do not confer any real media rights.
BEGIN;
DO $tests$
DECLARE
  legacy uuid;
  st uuid;
  lic uuid;
  complete_asset uuid;
  scr uuid;
  vid uuid;
  other_story uuid;
  other_script uuid;
  other_video uuid;
  denied boolean;
  reason text;
BEGIN
  SELECT id INTO legacy FROM vns.assets
  WHERE storage_key='p3/legacy-cleared';
  IF legacy IS NULL THEN RAISE EXCEPTION 'legacy setup missing'; END IF;

  SELECT render_allowed,reason INTO denied,reason
  FROM vns.asset_rights_readiness WHERE asset_id=legacy;
  IF denied IS DISTINCT FROM false OR reason<>'missing_provenance' THEN
    RAISE EXCEPTION 'legacy cleared asset was grandfathered';
  END IF;

  SELECT id INTO st FROM vns.stories WHERE slug='p3-legacy-fixture';
  SELECT id INTO lic FROM vns.licenses WHERE code='P3-LEGACY-TEST';

  INSERT INTO vns.assets(story_id,kind,storage_key)
  VALUES(st,'image','p3/missing-origin');
  IF NOT EXISTS (
    SELECT 1 FROM vns.asset_rights_readiness r
    JOIN vns.assets a ON a.id=r.asset_id
    WHERE a.storage_key='p3/missing-origin'
      AND r.effective_rights_status='BLOCKED'
      AND r.render_allowed=false AND r.reason='missing_provenance'
  ) THEN RAISE EXCEPTION 'asset without provenance not blocked'; END IF;

  BEGIN
    INSERT INTO vns.assets(story_id,license_id,kind,storage_key,
                           rights_status,rights_verified_at)
    VALUES(st,lic,'image','p3/invalid-clearance','cleared',clock_timestamp());
    RAISE EXCEPTION 'new clearance without provenance allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO vns.assets(story_id,kind,storage_key,origin_url)
    VALUES(st,'image','p3/invalid-url','http://invalid.example/image');
    RAISE EXCEPTION 'non-HTTPS origin allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO vns.assets(story_id,kind,storage_key,content_sha256)
    VALUES(st,'image','p3/invalid-hash','not-sha256');
    RAISE EXCEPTION 'invalid asset hash allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO vns.assets(story_id,kind,storage_key,rights_flags)
    VALUES(st,'image','p3/invalid-flags','[]'::jsonb);
    RAISE EXCEPTION 'non-object rights flags allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO vns.assets(
    story_id,license_id,kind,storage_key,origin_url,creator,license_url,
    license_snapshot,content_sha256,attribution,rights_status,rights_verified_at,
    rights_flags
  ) VALUES (
    st,lic,'image','p3/metadata-complete',
    'https://media.example.invalid/image.jpg','Synthetic Creator',
    'https://media.example.invalid/license',
    '{"captured_at":"2026-11-08T00:00:00Z","terms_digest":"synthetic-only"}'::jsonb,
    repeat('a',64),'Synthetic Creator / synthetic-only','cleared',clock_timestamp(),
    '{"commercial_use":"unreviewed"}'::jsonb
  ) RETURNING id INTO complete_asset;

  SELECT render_allowed,reason INTO denied,reason
  FROM vns.asset_rights_readiness WHERE asset_id=complete_asset;
  IF denied IS DISTINCT FROM false OR reason<>'license_policy_pending' THEN
    RAISE EXCEPTION 'complete metadata bypassed P3-02 policy';
  END IF;

  BEGIN
    UPDATE vns.assets SET origin_url='https://media.example.invalid/changed'
    WHERE id=complete_asset;
    RAISE EXCEPTION 'origin rewrite allowed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    UPDATE vns.assets SET license_snapshot='{"changed":true}'::jsonb
    WHERE id=complete_asset;
    RAISE EXCEPTION 'license snapshot rewrite allowed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    UPDATE vns.assets SET content_sha256=repeat('b',64)
    WHERE id=complete_asset;
    RAISE EXCEPTION 'asset digest rewrite allowed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  INSERT INTO vns.scripts(story_id,version,body)
  VALUES(st,1,'Synthetic script') RETURNING id INTO scr;
  INSERT INTO vns.videos(script_id) VALUES(scr) RETURNING id INTO vid;
  INSERT INTO vns.asset_uses(asset_id,video_id)
  VALUES(complete_asset,vid);
  IF (SELECT count(*) FROM vns.asset_uses
      WHERE asset_id=complete_asset AND video_id=vid)<>1
  THEN RAISE EXCEPTION 'asset use link missing'; END IF;

  INSERT INTO vns.stories(source_id,slug,title)
  SELECT source_id,'p3-other-fixture','Other synthetic story'
  FROM vns.stories WHERE id=st RETURNING id INTO other_story;
  INSERT INTO vns.scripts(story_id,version,body)
  VALUES(other_story,1,'Other synthetic script') RETURNING id INTO other_script;
  INSERT INTO vns.videos(script_id)
  VALUES(other_script) RETURNING id INTO other_video;
  BEGIN
    INSERT INTO vns.asset_uses(asset_id,video_id)
    VALUES(complete_asset,other_video);
    RAISE EXCEPTION 'cross-story asset use allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM vns.asset_rights_readiness WHERE render_allowed=true
  ) THEN RAISE EXCEPTION 'P3-01 admitted unreviewed rendering'; END IF;
END;
$tests$;
ROLLBACK;
