import assert from "node:assert/strict";
import test from "node:test";
import {
  assessOfficialFeedProposals,
  readOfficialFeedProposals,
} from "./p2_a_source_readiness.mjs";

test("three official-source proposals retain pending status, distinct publishers and explicit incompatibility", () => {
  const document = readOfficialFeedProposals();
  const readiness = assessOfficialFeedProposals(document);
  assert.equal(readiness.approvedForLive, false);
  assert.equal(readiness.currentRegistryReady, false);
  assert.equal(readiness.proposals.length, 3);
  assert.deepEqual(
    readiness.proposals.map((result) => result.id),
    ["nasa_jpl_news", "noaa_news", "usgs_national_news"],
  );
  assert.ok(readiness.proposals.every((result) =>
    result.approvedForLive === false &&
    result.reasons.includes("operator_legal_and_host_review_missing") &&
    result.reasons.includes("live_feed_response_unverified")
  ));
  assert.ok(readiness.proposals.some((result) =>
    result.reasons.includes("article_scope_outside_feed_base")
  ));
  assert.ok(readiness.proposals.some((result) =>
    result.reasons.includes("feed_url_not_directory")
  ));
});

test("nothing about a document can promote rights, skip publisher independence or admit arbitrary URLs", () => {
  const data = readOfficialFeedProposals();
  const fail = (change) =>
    assert.throws(() => assessOfficialFeedProposals(change), /invalid|distinct/);
  fail({ ...data, admission: "approved" });
  fail({ ...data, proposals: data.proposals.slice(0, 2) });
  fail({ ...data, proposals: [...data.proposals, data.proposals[0]] });
  fail({ ...data, proposals: data.proposals.map((p) => ({ ...p, rightsStatus: "approved" })) });
  fail({
    ...data,
    proposals: data.proposals.map((p, index) =>
      index === 1 ? { ...p, publisherGroup: "nasa" } : p),
  });
  for (const bad of [
    "http://www.noaa.gov/rss.xml",
    "https://www.noaa.gov@evil.example/rss.xml",
    "https://www.noaa.gov/rss.xml?token=secret",
    "https://www.noaa.gov/rss.xml#frag",
    "https://www.noaa.gov/%2e%2e/admin",
    "https://localhost/feed/",
  ]) {
    fail({
      ...data,
      proposals: data.proposals.map((p, index) => index === 1 ? { ...p, feedUrl: bad } : p),
    });
  }
});

test("model compatibility never means live operator approval", () => {
  const data = readOfficialFeedProposals();
  const proposal = data.proposals[0];
  const artificial = {
    ...proposal,
    feedUrl: "https://www.jpl.nasa.gov/news/",
    articleScope: "https://www.jpl.nasa.gov/news/",
  };
  const readiness = assessOfficialFeedProposals({
    ...data,
    proposals: [artificial, ...data.proposals.slice(1)],
  });
  assert.equal(readiness.proposals[0].compatibleWithCurrentRegistry, true);
  assert.equal(readiness.proposals[0].approvedForLive, false);
});
