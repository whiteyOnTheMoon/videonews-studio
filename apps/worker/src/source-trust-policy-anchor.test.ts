import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { sealDormantSourceExport } from "./source-export-signature.js";
import { prepareDormantSourceExport } from "./source-registry-export.js";
import {
  pinnedTrustPolicyDigest,
  verifyAnchoredRotatingSourceExport,
  type IndependentTrustPolicyAnchor,
} from "./source-trust-policy-anchor.js";

const fetchPolicy = { enabled: true as const, hosts: ["news.example.org"] };
const source = {
  id: "sample_news",
  baseUrl: "https://news.example.org/feed/",
  status: "approved" as const,
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic fixture.",
  reviewedAt: "2026-10-26",
};
const bundle = prepareDormantSourceExport(
  { revision: 8, sources: [source] },
  { revision: 8, approvedHosts: ["news.example.org"] },
);
const minimum = { sourceRevision: 1, hostApprovalRevision: 1 };

test("independent policy anchor rejects joint rollback of signed trust configuration", async () => {
  const old = generateKeyPairSync("ed25519");
  const newer = generateKeyPairSync("ed25519");
  const first = {
    policyRevision: 1,
    rotation: {
      epochs: [{ publicKey: old.publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1 }],
    },
  };
  const second = {
    policyRevision: 2,
    rotation: {
      epochs: [{ publicKey: newer.publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1 }],
    },
  };
  let highWater: { revision: number; sha: string } | null = null;
  const anchor: IndependentTrustPolicyAnchor = {
    async advancePolicy(revision, sha) {
      if (highWater && revision < highWater.revision) {
        throw new Error("independent policy rollback rejected");
      }
      if (highWater && revision === highWater.revision && sha !== highWater.sha) {
        throw new Error("independent policy equivocation rejected");
      }
      highWater = { revision, sha };
    },
  };
  const signedOld = sealDormantSourceExport(bundle, fetchPolicy, old.privateKey);
  const signedNew = sealDormantSourceExport(bundle, fetchPolicy, newer.privateKey);
  await verifyAnchoredRotatingSourceExport(signedOld, fetchPolicy, first, anchor, minimum);
  await verifyAnchoredRotatingSourceExport(signedNew, fetchPolicy, second, anchor, minimum);
  await assert.rejects(
    verifyAnchoredRotatingSourceExport(signedOld, fetchPolicy, first, anchor, minimum),
    /policy rollback rejected/,
  );
  const tampered = { ...second, rotation: first.rotation };
  await assert.rejects(
    verifyAnchoredRotatingSourceExport(signedOld, fetchPolicy, tampered, anchor, minimum),
    /equivocation rejected/,
  );
});

test("missing anchor and failed signatures never release sources", async () => {
  const keys = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519");
  const pinned = {
    policyRevision: 3,
    rotation: {
      epochs: [{ publicKey: keys.publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1 }],
    },
  };
  const valid = sealDormantSourceExport(bundle, fetchPolicy, keys.privateKey);
  const failed: IndependentTrustPolicyAnchor = {
    async advancePolicy() {
      throw new Error("anchor unavailable");
    },
  };
  await assert.rejects(
    verifyAnchoredRotatingSourceExport(valid, fetchPolicy, pinned, failed, minimum),
    /anchor unavailable/,
  );
  const mustNotAdvance: IndependentTrustPolicyAnchor = {
    async advancePolicy() {
      throw new Error("anchor called before signature verification");
    },
  };
  await assert.rejects(
    verifyAnchoredRotatingSourceExport(
      sealDormantSourceExport(bundle, fetchPolicy, wrong.privateKey),
      fetchPolicy,
      pinned,
      mustNotAdvance,
      minimum,
    ),
    /signature invalid/,
  );
  assert.equal(pinnedTrustPolicyDigest(pinned).length, 64);
  assert.throws(() => pinnedTrustPolicyDigest({ ...pinned, policyRevision: 0 }));
});
