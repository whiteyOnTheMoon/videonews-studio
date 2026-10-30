-- P2-03 0057: NFKC two-codepoint Unicode token set parity with
-- groupConservativeEventCandidates() in the worker (not semantic truth).
BEGIN;
DO $similarity$
BEGIN
 IF NOT vns.rank_headlines_overlap(
   'Science mission update confirmed today by agency a b c',
   'Science mission update confirmed today by agency x y z'
 ) THEN
   RAISE EXCEPTION 'Isolated one-character words incorrectly reduce Jaccard overlap';
 END IF;
 IF NOT vns.rank_headlines_overlap(
   'Ｆｕｌｌｗｉｄｔｈ science research breakthrough announced today a',
   'Fullwidth science research breakthrough announced today x'
 ) THEN
   RAISE EXCEPTION 'Unicode NFKC or one-letter filtering disagrees with TypeScript';
 END IF;
 IF NOT vns.rank_headlines_overlap(
   'Science science mission update confirmed today by agency',
   'Science mission update confirmed today by agency'
 ) THEN
   RAISE EXCEPTION 'Repeated words inflated the token-set denominator';
 END IF;
 IF vns.rank_headlines_overlap(
   'Science mission update confirmed today by agency biology',
   'Science mission update confirmed today by agency astronomy'
 ) THEN
   RAISE EXCEPTION 'Different substantive words bypassed Jaccard threshold';
 END IF;
 IF vns.rank_headlines_overlap(
   'A b c d e f g',
   'A b c d e f h'
 ) THEN
   RAISE EXCEPTION 'One-character tokens incorrectly counted as six shared words';
 END IF;
 IF vns.rank_headlines_overlap('Short science update','Science short update')
 THEN RAISE EXCEPTION 'Fewer than six substantive tokens accepted'; END IF;
END $similarity$;

-- Fullwidth NFKC and non-Latin whole-word handling must survive in the
-- isolated PostgreSQL cluster. Runtime-dependent lowercasing remains an
-- independent parity concern, not asserted as universally equivalent.
DO $unicode$
BEGIN
 IF vns.rank_nfkc_words('Ｆｕｌｌｗｉｄｔｈ science')<>'fullwidth science'
  OR vns.rank_nfkc_words('Café--research')<>'café research'
  OR vns.rank_nfkc_words('東京 ニュース 科学')<>'東京 ニュース 科学'
 THEN RAISE EXCEPTION 'Basic NFKC Unicode words unsupported'; END IF;
END $unicode$;
DO $rights$
BEGIN
 IF has_function_privilege('vns_feed_poll_writer',
    'vns.rank_headlines_overlap(text,text)','EXECUTE')
 OR has_function_privilege('vns_api_runtime',
    'vns.rank_headlines_overlap(text,text)','EXECUTE')
 OR NOT has_function_privilege('vns_feed_project_executor',
    'vns.rank_headlines_overlap(text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Source worker could execute private projector scoring'; END IF;
END $rights$;
ROLLBACK;
