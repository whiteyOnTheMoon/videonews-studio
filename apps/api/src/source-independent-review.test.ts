import assert from "node:assert/strict";
import test from "node:test";
import { PostgresIndependentSourceReviewPreflight } from "./source-independent-review.js";

const actor = { id: "ca220001-1111-4111-8111-111111111111", authVersion: 0 };

test("separate reviewer is checked through bounded named audit lookup", async () => {
  let called = 0;
  const preflight = new PostgresIndependentSourceReviewPreflight({
    async query(sql, params) {
      called += 1;
      assert.match(sql, /audit\.editor_id <> \$3::uuid/);
      assert.match(sql, /audit\.action = 'approve'/);
      assert.match(sql, /source\.record->>'status' = 'approved'/);
      assert.deepEqual(params, ["ci_host_source", "news.example.org", actor.id]);
      return { rows: [{ approved: true }] };
    },
  });
  assert.equal(await preflight.hasIndependentApproval("ci_host_source", "news.example.org", actor), true);
  assert.equal(called, 1);
});

test("self-approval and ambiguous results fail closed", async () => {
  for (const rows of [[], [{ approved: "true" }], [{ approved: false }, { approved: true }]]) {
    const preflight = new PostgresIndependentSourceReviewPreflight({
      async query() {
        return { rows };
      },
    });
    await assert.rejects(
      preflight.hasIndependentApproval("ci_host_source", "news.example.org", actor),
    );
  }
  const denied = new PostgresIndependentSourceReviewPreflight({
    async query() {
      return { rows: [{ approved: false }] };
    },
  });
  assert.equal(await denied.hasIndependentApproval("ci_host_source", "news.example.org", actor), false);
});

test("invalid actor and source input never reaches SQL", async () => {
  const preflight = new PostgresIndependentSourceReviewPreflight({
    async query() {
      throw new Error("SQL was called");
    },
  });
  await assert.rejects(preflight.hasIndependentApproval("../source", "news.example.org", actor), /input invalid/);
  await assert.rejects(
    preflight.hasIndependentApproval("ci_host_source", "news.example.org", {
      ...actor,
      id: "invalid",
    }),
    /input invalid/,
  );
});
