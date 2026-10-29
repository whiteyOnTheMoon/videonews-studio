import assert from "node:assert/strict";
import test from "node:test";
import { parseDormantSourceExport, prepareDormantSourceExport } from "./source-registry-export.js";
import { approvedSourceForUrl } from "./source-registry.js";

function source(id: string, baseUrl: string, status: "approved" | "pending" | "blocked") {
  return {
    id,
    baseUrl,
    status,
    access: "rss",
    intervalMinutes: 60,
    termsUrl: "https://news.example.org/terms/",
    usage: "metadata_only",
    licenseNotes: "Synthetic metadata only, subject to manual review.",
    reviewedAt: "2026-10-26",
  } as const;
}
const parent = source("parent_feed", "https://news.example.org/news/", "approved");
const blockedChild = source("blocked_feed", "https://news.example.org/news/private/", "blocked");
const pendingChild = source("pending_feed", "https://news.example.org/news/drafts/", "pending");
const irrelevant = source("other_pending", "https://other.example.org/drafts/", "pending");
const snapshot = { revision: 9, sources: [irrelevant, blockedChild, parent, pendingChild] };
const grant = { revision: 3, approvedHosts: ["news.example.org"] };
const policy = { enabled: true as const, hosts: ["news.example.org"] };

test("deterministic export keeps blocked child rules and omits unrelated pending hosts", () => {
  const first = prepareDormantSourceExport(snapshot, grant);
  const again = prepareDormantSourceExport(
    { revision: 9, sources: [...snapshot.sources].reverse() },
    grant,
  );
  assert.deepEqual(first, again);
  assert.equal(first.sourceRevision, 9);
  assert.equal(first.hostApprovalRevision, 3);
  assert.deepEqual(first.allowedHosts, ["news.example.org"]);
  const parsed = parseDormantSourceExport(first, policy, {
    sourceRevision: 9,
    hostApprovalRevision: 3,
  });
  assert.equal(parsed.length, 3);
  assert.equal(
    parsed.some((entry) => entry.id === irrelevant.id),
    false,
  );
  assert.equal(
    approvedSourceForUrl("https://news.example.org/news/article/", parsed)?.id,
    parent.id,
  );
  assert.equal(
    approvedSourceForUrl("https://news.example.org/news/private/article/", parsed),
    null,
  );
  assert.equal(approvedSourceForUrl("https://news.example.org/news/drafts/article/", parsed), null);
});

test("an admin source approval cannot add its own network host permission", () => {
  const otherApproved = source("other_approved", "https://other.example.org/feed/", "approved");
  assert.throws(
    () => prepareDormantSourceExport({ revision: 10, sources: [parent, otherApproved] }, grant),
    /grant/,
  );
  assert.throws(
    () =>
      prepareDormantSourceExport(snapshot, {
        revision: 4,
        approvedHosts: ["news.example.org", "extra.example.org"],
      }),
    /grant/,
  );
  assert.throws(
    () =>
      prepareDormantSourceExport(
        {
          revision: 10,
          sources: [source("still_pending", "https://news.example.org/", "pending")],
        },
        grant,
      ),
    /grant/,
  );
});

test("untrusted host approval shape or invalid source entry fails closed", () => {
  for (const invalidGrant of [
    null,
    { ...grant, token: "synthetic" },
    { revision: -1, approvedHosts: ["news.example.org"] },
    { revision: 3, approvedHosts: [] },
    { revision: 3, approvedHosts: ["news.example.org", "news.example.org"] },
    { revision: 3, approvedHosts: ["127.0.0.1"] },
    { revision: 3, approvedHosts: ["localhost"] },
    { revision: 3, approvedHosts: ["xn--unsafe.example.org"] },
    { revision: 3, approvedHosts: ["news.example.org", "broken"] },
  ]) {
    assert.throws(() => prepareDormantSourceExport(snapshot, invalidGrant));
  }
  for (const invalid of [
    { ...parent, status: "active" },
    { ...parent, apiKey: "fake-key" },
    { ...parent, baseUrl: "http://127.0.0.1/feed/" },
    { ...parent, intervalMinutes: 1 },
    { ...parent, licenseNotes: "" },
    { ...parent, reviewedAt: "2026-02-30" },
  ]) {
    assert.throws(() => prepareDormantSourceExport({ revision: 10, sources: [invalid] }, grant));
  }
  assert.throws(() =>
    prepareDormantSourceExport({ revision: 10, sources: [parent, parent] }, grant),
  );
});

test("export is not trusted without matching independent policy and monotonic revisions", () => {
  const bundle = prepareDormantSourceExport(snapshot, grant);
  const checkpoint = { sourceRevision: 9, hostApprovalRevision: 3 };
  assert.throws(
    () =>
      parseDormantSourceExport(
        bundle,
        {
          enabled: true,
          hosts: ["other.example.org"],
        },
        checkpoint,
      ),
    /independently/,
  );
  assert.throws(() =>
    parseDormantSourceExport(bundle, policy, {
      sourceRevision: 10,
      hostApprovalRevision: 3,
    }),
  );
  assert.throws(() =>
    parseDormantSourceExport(bundle, policy, {
      sourceRevision: 9,
      hostApprovalRevision: 4,
    }),
  );
  for (const tampered of [
    { ...bundle, sourceRevision: 10 },
    { ...bundle, allowedHosts: ["other.example.org"] },
    { ...bundle, registryJson: bundle.registryJson.replace('"approved"', '"pending"') },
    { ...bundle, sha256: "0".repeat(64) },
    { ...bundle, apiKey: "synthetic" },
  ]) {
    assert.throws(() => parseDormantSourceExport(tampered, policy, checkpoint));
  }
  assert.equal(parseDormantSourceExport(bundle, policy, checkpoint).length, 3);
});

test("signed reviewed export retains exact RSS endpoint and article allow-scope", () => {
  const separate = {
    ...parent,
    feedUrl: "https://news.example.org/rss.xml",
  };
  const snapshot = { revision: 11, sources: [separate, blockedChild] };
  const bundle = prepareDormantSourceExport(snapshot, grant);
  const verified = parseDormantSourceExport(bundle, policy, {
    sourceRevision: 11,
    hostApprovalRevision: 3,
  });
  assert.equal(verified.find((item) => item.id === separate.id)?.feedUrl, separate.feedUrl);
  assert.equal(
    approvedSourceForUrl("https://news.example.org/news/current-event", verified)?.id,
    separate.id,
  );
  assert.equal(approvedSourceForUrl("https://news.example.org/rss.xml", verified), null);
  const forged = { ...bundle, registryJson: bundle.registryJson.replace("rss.xml", "forged.xml") };
  assert.throws(() =>
    parseDormantSourceExport(forged, policy, {
      sourceRevision: 11,
      hostApprovalRevision: 3,
    }),
  );
});
