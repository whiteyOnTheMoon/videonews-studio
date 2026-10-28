import assert from "node:assert/strict";
import test from "node:test";
import { verifyCheckpointPage, verifyTimelinePage } from "./editorial-export-continuity";

const ACTOR = "ca310001-1111-4111-8111-111111111111";
const EVENT_A = "ca310002-2222-4222-8222-222222222222";
const EVENT_B = "ca310003-3333-4333-8333-333333333333";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const ZERO = "0".repeat(64);

function checkpoint(revision: number, previous_sha256: string, chain_sha256: string) {
  return {
    revision,
    stage: "quality",
    outcome: "blocked",
    actor_id: ACTOR,
    artifact_sha256: DIGEST_A,
    reason_codes: ["claim_not_independently_supported"],
    score: null,
    previous_sha256,
    chain_sha256,
    recorded_at: "2026-10-26T12:00:00.000Z",
  };
}

test("checkpoint export requires contiguous revisions, matching linked digest and accurate cursor", () => {
  const first = checkpoint(1, ZERO, DIGEST_A);
  assert.deepEqual(verifyCheckpointPage([first], { revision: 0, chain: null }, 1), {
    revision: 1,
    chain: DIGEST_A,
  });
  const second = checkpoint(2, DIGEST_A, DIGEST_B);
  assert.deepEqual(verifyCheckpointPage([second], { revision: 1, chain: DIGEST_A }, 2), {
    revision: 2,
    chain: DIGEST_B,
  });
  for (const invalid of [
    checkpoint(3, DIGEST_A, DIGEST_B),
    checkpoint(2, ZERO, DIGEST_B),
    { ...second, actor_id: "forged" },
    { ...second, reason_codes: [] },
    { ...second, chain_sha256: "invalid" },
  ]) {
    assert.equal(verifyCheckpointPage([invalid], { revision: 1, chain: DIGEST_A }, 2), null);
  }
  assert.equal(verifyCheckpointPage([second], { revision: 1, chain: DIGEST_A }, 99), null);
});

test("timeline export rejects reordered, repeated and mismatched cursors", () => {
  const first = {
    event_id: EVENT_A,
    actor_id: ACTOR,
    event_kind: "decision",
    reference_uri: "https://news.example.org/article",
    document_sha256: DIGEST_A,
    details: { summary: "The editor blocked the unverified claim.", reasonCodes: ["unverified_claim"] },
    recorded_at: "2026-10-26T12:00:00.000Z",
  };
  const second = {
    event_id: EVENT_B,
    actor_id: ACTOR,
    event_kind: "script_revision",
    reference_uri: null,
    document_sha256: DIGEST_B,
    details: { summary: "The draft is held for human review.", reasonCodes: ["review_required"] },
    recorded_at: "2026-10-26T12:00:00.000Z",
  };
  const last = { afterTime: second.recorded_at, afterId: second.event_id };
  assert.deepEqual(verifyTimelinePage([first, second], null, last), last);
  assert.equal(
    verifyTimelinePage([first, second], null, {
      ...last,
      afterId: EVENT_A,
    }),
    null,
  );
  assert.equal(
    verifyTimelinePage([first], last, {
      afterTime: first.recorded_at,
      afterId: first.event_id,
    }),
    null,
  );
  assert.equal(
    verifyTimelinePage([second, first], null, {
      afterTime: first.recorded_at,
      afterId: first.event_id,
    }),
    null,
  );
  assert.equal(
    verifyTimelinePage([{ ...first, event_kind: "publish" }], null, {
      afterTime: first.recorded_at,
      afterId: first.event_id,
    }),
    null,
  );
});

test("checkpoint export rejects missing fields, altered genesis and unknown payloads", () => {
  const row = checkpoint(1, ZERO, DIGEST_A);
  for (const forged of [
    { ...row, previous_sha256: DIGEST_B },
    { ...row, artifact_sha256: undefined },
    { ...row, reason_codes: ["invalid_reason", "bad!"] },
    { ...row, secret: "not_in_sql_projection" },
  ]) {
    assert.equal(verifyCheckpointPage([forged], { revision: 0, chain: null }, 1), null);
  }
  assert.equal(verifyCheckpointPage([row], { revision: 1, chain: null }, 1), null);
  assert.equal(verifyCheckpointPage([row], { revision: 0, chain: DIGEST_A }, 1), null);
});

test("timeline export refuses rows without full audit content or with unexpected fields", () => {
  const row = {
    event_id: EVENT_A,
    actor_id: ACTOR,
    event_kind: "claim_rejected",
    reference_uri: "https://news.example.org/story",
    document_sha256: DIGEST_A,
    details: {
      summary: "This claim is not supported by the independent evidence.",
      reasonCodes: ["claim_not_supported"],
    },
    recorded_at: "2026-10-26T12:00:00.000Z",
  };
  const cursor = { afterTime: row.recorded_at, afterId: row.event_id };
  assert.deepEqual(verifyTimelinePage([row], null, cursor), cursor);
  for (const tampered of [
    { ...row, details: undefined },
    { ...row, details: {} },
    { ...row, details: { summary: "Missing a reason code", reasonCodes: [] } },
    { ...row, details: { ...row.details, secret: "unreviewed" } },
    { ...row, reference_uri: "https://news.example.org/story?token=secret" },
    { ...row, document_sha256: "bad" },
    { ...row, actor_id: "wrong" },
    { ...row, unrelated: "not_from_db" },
  ]) {
    assert.equal(verifyTimelinePage([tampered], null, cursor), null);
  }
});
