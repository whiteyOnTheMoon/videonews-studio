BEGIN;
DO $test$
DECLARE a uuid; e uuid; c uuid; refused boolean;
BEGIN
 INSERT INTO vns.research_articles(source_key,canonical_url,headline,
 headline_sha256,published_at)
 VALUES('ci_source','https://news.example.org/article/1',
 'A synthetic research headline','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 '2026-10-26T10:00:00Z') RETURNING article_id INTO a;
 INSERT INTO vns.research_events(event_fingerprint,label)
 VALUES('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 'A synthetic research event') RETURNING event_id INTO e;
 INSERT INTO vns.research_event_articles(event_id,article_id) VALUES(e,a);
 INSERT INTO vns.research_claims(event_id,statement)
 VALUES(e,'A synthetic statement requiring verification') RETURNING claim_id INTO c;
 INSERT INTO vns.research_claim_evidence(claim_id,article_id,reference_url)
 VALUES(c,a,'https://news.example.org/article/1');
 IF (SELECT verification_status FROM vns.research_claims WHERE claim_id=c) <> 'unverified'
 THEN RAISE EXCEPTION 'claims must default to unverified'; END IF;
 refused:=false;
 BEGIN
  INSERT INTO vns.research_articles(source_key,canonical_url,headline,
  headline_sha256,published_at)
  VALUES('ci_source','https://news.example.org/article/1','Another synthetic article',
  repeat('c',64),'2026-10-26T10:00:00Z');
 EXCEPTION WHEN unique_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'duplicate canonical URL accepted'; END IF;
 refused:=false;
 BEGIN
  INSERT INTO vns.research_claims(event_id,statement,verification_status)
  VALUES(e,'An unsupported verified factual statement','verified');
 EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'unreviewed verified claim accepted'; END IF;
 IF has_table_privilege('vns_api_runtime','vns.research_claims','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.research_articles','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.research_claim_evidence','UPDATE')
 THEN RAISE EXCEPTION 'unsafe research runtime grants'; END IF;
END $test$;
ROLLBACK;
