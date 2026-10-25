-- CI-only committed fixtures for two simultaneous reservations at a near-full day.
-- Runs only in disposable GitHub Actions postgres:17-alpine test container.
DO $setup$
DECLARE
  n integer;
  j uuid;
BEGIN
  FOR n IN 1..21 LOOP
    INSERT INTO vns.jobs(kind,idempotency_key)
    VALUES('script', 'ci-parallel-fill-job-'||n) RETURNING id INTO j;
    PERFORM vns.reserve_synthetic_ai_budget(
      j, 'ci_parallel_fill_000001', 'script_draft', 'gpt-6.1-sol',
      20000, 5000, DATE '2026-10-28');
  END LOOP;
  INSERT INTO vns.jobs(id,kind,idempotency_key)
  VALUES
    ('e0a11111-1111-4111-8111-111111111111','script','ci-parallel-contender-a'),
    ('e0a22222-2222-4222-8222-222222222222','script','ci-parallel-contender-b'),
    ('e0a33333-3333-4333-8333-333333333333','script','ci-parallel-same-request');

  IF (SELECT reserved_micro_usd FROM vns.synthetic_ai_budget_days
      WHERE budget_day=DATE '2026-10-28')<>1890000 THEN
    RAISE EXCEPTION 'Parallel budget fixture starting state incorrect';
  END IF;
END;
$setup$;
