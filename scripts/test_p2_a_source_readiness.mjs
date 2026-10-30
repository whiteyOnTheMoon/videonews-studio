import assert from "node:assert/strict";
import test from "node:test";
import {
  assessOfficialFeedProposals,
  readOfficialFeedProposals,
} from "./p2_a_source_readiness.mjs";

test("three separate official feed URLs match the 0050 same-host registry while remaining unapproved", () => {
  const document = readOfficialFeedProposals();
  const readiness = assessOfficialFeedProposals(document);
  assert.equal(readiness.approvedForLive, false);
  assert.equal(readiness.currentRegistryReady, true);
  assert.equal(readiness.proposals.length, 3);
  assert.deepEqual(
    readiness.proposals.map((result) => result.id),
    ["nasa_jpl_news", "noaa_news", "usgs_national_news"],
  );
  assert.ok(
    readiness.proposals.every(
      (result) =>
        result.approvedForLive === false &&
        result.reasons.includes("operator_legal_and_host_review_missing") &&
        result.reasons.includes("live_feed_response_unverified") &&
        result.reasons.includes("per_item_rights_and_attribution_unverified") &&
        result.compatibleWithCurrentRegistry === true,
    ),
  );
  assert.ok(
    readiness.proposals.every(
      (result) =>
        !result.reasons.includes("feed_article_host_mismatch") &&
        !result.reasons.includes("feed_url_equals_article_scope"),
    ),
  );
  assert.match(readiness.nextStep, /supported since 0050/);
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
      index === 1 ? { ...p, publisherGroup: "nasa" } : p,
    ),
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
      proposals: data.proposals.map((p, index) => (index === 1 ? { ...p, feedUrl: bad } : p)),
    });
  }
});

test("same-host-but-separate paths are compatible, without ever implying rights approval", () => {
  const readiness = assessOfficialFeedProposals(readOfficialFeedProposals());
  assert.equal(readiness.currentRegistryReady, true);
  assert.equal(readiness.approvedForLive, false);
  assert.ok(readiness.proposals.every((item) => item.approvedForLive === false));
});

test("a separate feedUrl on another host is structurally incompatible", () => {
  const data = readOfficialFeedProposals();
  const wrongHost = {
    ...data.proposals[0],
    feedUrl: "https://www.nasa.gov/news-release/feed/",
  };
  const readiness = assessOfficialFeedProposals({
    ...data,
    proposals: [wrongHost, ...data.proposals.slice(1)],
  });
  assert.equal(readiness.currentRegistryReady, false);
  assert.deepEqual(
    readiness.proposals[0].reasons.filter((reason) => reason === "feed_article_host_mismatch"),
    ["feed_article_host_mismatch"],
  );
  assert.equal(readiness.proposals[0].approvedForLive, false);
});

test("supplying an identical feedUrl and baseUrl must not pass the optional feedUrl gate", () => {
  const data = readOfficialFeedProposals();
  const sameUrl = {
    ...data.proposals[0],
    feedUrl: data.proposals[0].articleScope,
  };
  const readiness = assessOfficialFeedProposals({
    ...data,
    proposals: [sameUrl, ...data.proposals.slice(1)],
  });
  assert.equal(readiness.proposals[0].compatibleWithCurrentRegistry, false);
  assert.ok(readiness.proposals[0].reasons.includes("feed_url_equals_article_scope"));
  assert.equal(readiness.approvedForLive, false);
});
