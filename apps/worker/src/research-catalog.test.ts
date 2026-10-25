import assert from "node:assert/strict";
import test from "node:test";
import {
  createApprovedCatalogDiscovery,
  parseApprovedResearchCatalog,
} from "./research-catalog.js";

const topic = "Regional investment in sustainable public transport";
const candidate = {
  sourceUrl: "https://www.example.org/reports/mobility",
  publisher: "Example Transport Institute",
  headline: "Annual infrastructure review",
  claim: "The report presents a transport investment overview.",
};
const policy = { enabled: true as const, hosts: ["www.example.org"] };
const catalogJson = (topics: unknown[]) => JSON.stringify({ version: 1, topics });
const valid = () => ({ topic, candidates: [candidate] });

test("only exact operator-catalog topics can be discovered", async () => {
  const catalog = parseApprovedResearchCatalog(catalogJson([valid()]), policy);
  const discovery = createApprovedCatalogDiscovery(catalog);
  assert.deepEqual(await discovery.discover(topic), [candidate]);
  await assert.rejects(discovery.discover(topic.toLowerCase()), /not operator approved/);
  await assert.rejects(discovery.discover("A totally unrelated headline"), /not operator approved/);
  assert.equal("verified" in ((await discovery.discover(topic)) as object[])[0]!, false);
});

test("refuse missing catalog, malformed envelope and auto-verified input", () => {
  for (const data of [
    "",
    "not json",
    "{}",
    JSON.stringify({ version: 1, topics: [] }),
    JSON.stringify({ version: 2, topics: [valid()] }),
    JSON.stringify({ version: 1, topics: [valid()], enabled: true }),
    catalogJson([valid(), valid()]),
    catalogJson([{ topic: "short", candidates: [candidate] }]),
    catalogJson([{ topic, candidates: [] }]),
    catalogJson([{ topic, candidates: Array.from({ length: 4 }, () => candidate) }]),
    catalogJson([{ topic, candidates: [{ ...candidate, reviewStatus: "verified" }] }]),
    catalogJson([{ topic, candidates: [candidate, candidate] }]),
    catalogJson([valid()]) + " ".repeat(33000),
  ]) {
    assert.throws(() => parseApprovedResearchCatalog(data, policy));
  }
});

test("deny unapproved source hosts and non-HTTPS/internal URLs", () => {
  for (const url of [
    "https://other.example.org/article/long-enough",
    "https://127.0.0.1/secret",
    "http://www.example.org/reports/mobility",
    "https://www.example.org:8443/hidden",
    "https://www.example.org/reports/mobility#fragment",
  ]) {
    assert.throws(() =>
      parseApprovedResearchCatalog(
        catalogJson([{ topic, candidates: [{ ...candidate, sourceUrl: url }] }]),
        policy,
      ),
    );
  }
});

test("exact allowlist and no editorial side effects", () => {
  assert.throws(() =>
    parseApprovedResearchCatalog(catalogJson([valid()]), { enabled: true, hosts: [] }),
  );
  const result = parseApprovedResearchCatalog(catalogJson([valid()]), policy);
  assert.equal(result.size, 1);
});
