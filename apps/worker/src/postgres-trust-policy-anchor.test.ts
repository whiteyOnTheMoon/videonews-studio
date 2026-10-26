import assert from "node:assert/strict";
import test from "node:test";
import { postgresTrustPolicyAnchor } from "./postgres-trust-policy-anchor.js";

const digest = "a".repeat(64);

test("trust policy adapter calls the restricted server function once", async () => {
  let calls = 0;
  const anchor = postgresTrustPolicyAnchor({
    async query(sql, args) {
      calls += 1;
      assert.equal(
        sql,
        "SELECT vns_source_anchor.advance_trust_policy($1::bigint, $2::text) AS accepted",
      );
      assert.deepEqual(args, [4, digest]);
      return { rowCount: 1, rows: [{ accepted: true }] };
    },
  });
  await anchor.advancePolicy(4, digest);
  assert.equal(calls, 1);
});

test("invalid trust revisions never reach SQL", async () => {
  const anchor = postgresTrustPolicyAnchor({
    async query() {
      throw new Error("query must not run");
    },
  });
  for (const [revision, sha] of [[0, digest], [-1, digest], [1.5, digest], [1, "invalid"]] as const) {
    await assert.rejects(anchor.advancePolicy(revision, sha), /Invalid trust policy/);
  }
});

test("ambiguous, rejected and unavailable authority fails closed", async () => {
  for (const response of [
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ accepted: false }] },
    { rowCount: 1, rows: [{ accepted: "true" }] },
    { rowCount: 2, rows: [{ accepted: true }] },
  ]) {
    await assert.rejects(
      postgresTrustPolicyAnchor({
        async query() {
          return response;
        },
      }).advancePolicy(4, digest),
      /admission refused/,
    );
  }
  await assert.rejects(
    postgresTrustPolicyAnchor({
      async query() {
        throw new Error("secret internal connection detail");
      },
    }).advancePolicy(4, digest),
    /^Error: Trust policy admission refused$/,
  );
});
