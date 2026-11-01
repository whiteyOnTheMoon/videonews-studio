import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { AnchorQuery } from "./postgres-source-revision-anchor.js";
import { pinnedTrustPolicyDigest } from "./source-trust-policy-anchor.js";
import { advancePinnedFeedTrustPolicy } from "./feed-trust-policy-runtime.js";

const digestFor = (key: ReturnType<typeof generateKeyPairSync>["publicKey"], revision: number) =>
  pinnedTrustPolicyDigest({
    policyRevision: revision,
    rotation: {
      epochs: [{ publicKey: key, fromSourceRevision: 1, fromHostApprovalRevision: 1 }],
    },
  });

test("live policy admission calls independent monotonic authority with pinned key fingerprint", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  let calls = 0;
  const db: AnchorQuery = {
    async query(sql, params) {
      calls += 1;
      assert.equal(
        sql,
        "SELECT vns_source_anchor.advance_trust_policy($1::bigint, $2::text) AS accepted",
      );
      assert.deepEqual(params, [4, digestFor(publicKey, 4)]);
      return { rowCount: 1, rows: [{ accepted: true }] };
    },
  };
  await advancePinnedFeedTrustPolicy(db, publicKey, 4);
  assert.equal(calls, 1);
});

test("same policy revision with replaced key is rejected by remote high-water authority", async () => {
  const keyA = generateKeyPairSync("ed25519").publicKey;
  const keyB = generateKeyPairSync("ed25519").publicKey;
  let pinned: { revision: number; digest: string } | undefined;
  const db: AnchorQuery = {
    async query(_sql, [revision, digest]) {
      const rev = revision as number;
      const sha = digest as string;
      if (
        pinned &&
        (rev < pinned.revision || (rev === pinned.revision && sha !== pinned.digest))
      ) {
        return { rowCount: 1, rows: [{ accepted: false }] };
      }
      pinned = { revision: rev, digest: sha };
      return { rowCount: 1, rows: [{ accepted: true }] };
    },
  };
  await advancePinnedFeedTrustPolicy(db, keyA, 1);
  await assert.rejects(
    advancePinnedFeedTrustPolicy(db, keyB, 1),
    /Independent feed trust policy admission denied/,
  );
  await assert.rejects(
    advancePinnedFeedTrustPolicy(db, keyA, 0),
    /Independent feed trust policy admission denied/,
  );
});

test("invalid keys, unavailable authority and malformed admission never release sources", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let calls = 0;
  const db: AnchorQuery = {
    async query() {
      calls++;
      throw new Error("SENSITIVE_EXTERNAL_ANCHOR_CONNECTION_DETAIL");
    },
  };
  await assert.rejects(
    advancePinnedFeedTrustPolicy(db, privateKey, 1),
    /^Error: Independent feed trust policy admission denied$/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    advancePinnedFeedTrustPolicy(db, publicKey, 1),
    /^Error: Independent feed trust policy admission denied$/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    advancePinnedFeedTrustPolicy(
      {
        async query() {
          return { rowCount: 1, rows: [{ accepted: "true" }] };
        },
      },
      publicKey,
      1,
    ),
    /admission denied/,
  );
});
