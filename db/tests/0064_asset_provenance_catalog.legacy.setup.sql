-- Synthetic historical "cleared" asset created BEFORE the P3-01 migration.
-- Its missing provenance must NOT gain render eligibility after upgrade.
INSERT INTO vns.sources(name,canonical_url)
VALUES ('P3 legacy source','https://legacy.example.invalid/source');
INSERT INTO vns.licenses(code,name)
VALUES ('P3-LEGACY-TEST','Synthetic legacy license');
INSERT INTO vns.stories(source_id,slug,title)
SELECT id,'p3-legacy-fixture','P3 legacy fixture'
FROM vns.sources WHERE canonical_url='https://legacy.example.invalid/source';
INSERT INTO vns.assets(story_id,license_id,kind,storage_key,
                       rights_status,rights_verified_at)
SELECT s.id,l.id,'image','p3/legacy-cleared','cleared',clock_timestamp()
FROM vns.stories s CROSS JOIN vns.licenses l
WHERE s.slug='p3-legacy-fixture' AND l.code='P3-LEGACY-TEST';
