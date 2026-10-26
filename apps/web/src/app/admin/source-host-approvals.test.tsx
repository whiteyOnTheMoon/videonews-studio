import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import SourceHostApprovals, { reviewableHostChoices } from "./source-host-approvals";

const sample = {
  id: "sample_news",
  baseUrl: "https://news.example.org/feed/",
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic reviewed rights for this fixture.",
  status: "approved" as const,
  reviewedAt: "2026-10-26",
};
test("disabled host Admin form renders no selectable permission or network requests", () => {
  const html = renderToStaticMarkup(<SourceHostApprovals enabled={false} />);
  assert.match(html, /Separate Host-Freigaben/);
  assert.match(html, /nicht aktiviert/);
  assert.doesNotMatch(html, /<form|<input|<button|<select|news\.example\.org/);
});
test("enabled initial render has no host controls until gated reads succeed", () => {
  const html = renderToStaticMarkup(<SourceHostApprovals enabled />);
  assert.match(html, /Lade geschützte Host-Freigaben/);
  assert.doesNotMatch(html, /<form|<input|<button|<select|news\.example\.org/);
});
test("only reviewed sources can be granted; previously granted hosts may be revoked", () => {
  const state = {
    sources: {
      revision: 4,
      sources: [
        sample,
        {
          ...sample,
          id: "pending_feed",
          status: "pending" as const,
          baseUrl: "https://pending.example.org/feed/",
        },
        {
          ...sample,
          id: "blocked_feed",
          status: "blocked" as const,
          baseUrl: "https://blocked.example.org/feed/",
        },
        { ...sample, id: "second_feed", baseUrl: "https://news.example.org/other/" },
      ],
    },
    hosts: { revision: 5, approvedHosts: ["old.example.org"], feedActive: false as const },
  };
  assert.deepEqual(reviewableHostChoices(state), [
    { host: "news.example.org", action: "grant" },
    { host: "old.example.org", action: "revoke" },
  ]);
  assert.deepEqual(
    reviewableHostChoices({
      ...state,
      hosts: { revision: 6, approvedHosts: ["news.example.org"], feedActive: false },
    }),
    [{ host: "news.example.org", action: "revoke" }],
  );
});
