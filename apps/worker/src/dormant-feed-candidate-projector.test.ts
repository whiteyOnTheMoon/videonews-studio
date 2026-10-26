import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { DormantFeedCandidateProjector } from "./dormant-feed-candidate-projector.js";

const flags: NodeJS.ProcessEnv = {
  VNS_FEED_CANDIDATE_PROJECTION_ENABLED: "true",
  VNS_FEED_CANDIDATE_OPERATOR_ACK: "true",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
};

test("projection is off by default and cannot query with missing approvals", () => {
  let queries = 0;
  const pool = {
    async query() {
      queries++;
      return { rows: [{ projected: 1 }] };
    },
  } as unknown as Pool;
  for (const key of Object.keys(flags)) {
    assert.throws(
      () => new DormantFeedCandidateProjector(pool, { ...flags, [key]: "false" }),
      /disabled/,
    );
  }
  assert.throws(() => new DormantFeedCandidateProjector(pool, {}), /disabled/);
  assert.equal(queries, 0);
});

test("strict parameterized projection returns only bounded count", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ projected: calls.length === 1 ? 2 : 0 }] };
    },
  } as unknown as Pool;
  const projector = new DormantFeedCandidateProjector(pool, flags);
  assert.equal(await projector.project("ci_projection_feed", 2), 2);
  assert.equal(await projector.project("ci_projection_feed", 2), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.sql, "SELECT vns.project_feed_candidates($1::text,$2::integer) AS projected");
  assert.deepEqual(calls[0]!.params, ["ci_projection_feed", 2]);
  assert.ok(calls.every(({ sql }) => !sql.includes("ci_projection_feed")));
});

test("malformed requests fail without touching the database", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rows: [{ projected: 1 }] };
    },
  } as unknown as Pool;
  const projector = new DormantFeedCandidateProjector(pool, flags);
  for (const [source, limit] of [
    ["bad source", 2],
    ["ci_projection_feed", 0],
    ["ci_projection_feed", 101],
    ["ci_projection_feed", 1.5],
  ] as const) {
    await assert.rejects(projector.project(source, limit), /input invalid/);
  }
  assert.equal(queried, false);
});

test("SQL failures and forged responses are redacted and fail closed", async () => {
  for (const response of [
    { rows: [] },
    { rows: [{ projected: 3 }] },
    { rows: [{ projected: "1" }] },
    { rows: [{ projected: 1 }, { projected: 1 }] },
  ]) {
    const pool = { async query() { return response; } } as unknown as Pool;
    const projector = new DormantFeedCandidateProjector(pool, flags);
    await assert.rejects(projector.project("ci_projection_feed", 2), /unavailable/);
  }
  const pool = {
    async query() {
      throw new Error("Sensitive SQL credentials and candidate URL");
    },
  } as unknown as Pool;
  const projector = new DormantFeedCandidateProjector(pool, flags);
  await assert.rejects(projector.project("ci_projection_feed", 2), (error: unknown) => {
    assert.equal((error as Error).message, "Feed candidate projection unavailable");
    return true;
  });
});
