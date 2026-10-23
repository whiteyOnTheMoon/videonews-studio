import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { issueIdFromTitle, validateBacklog, planImport } from "./import-issues.mjs";

test("parses only stable project IDs at start of issue titles", () => {
  assert.equal(issueIdFromTitle("[P1-01] Bootstrap"), "P1-01");
  assert.equal(issueIdFromTitle("Unrelated issue"), null);
});

test("the canonical backlog contains 69 unique, valid issues", async () => {
  const source = JSON.parse(
    await readFile(new URL("../backlog/issues.json", import.meta.url), "utf8"),
  );
  const issues = validateBacklog(source);
  assert.equal(issues.length, 69);
  assert.equal(new Set(issues.map((issue) => issue.id)).size, 69);
});

test("rejects duplicate IDs and wrong title prefixes", () => {
  const item = { id: "P1-01", title: "[P1-01] Test", body: "Test" };
  assert.throws(() => validateBacklog({ issues: [item, item] }), /Duplicate backlog ID/);
  assert.throws(
    () => validateBacklog({ issues: [{ ...item, title: "[P1-02] Test" }] }),
    /Invalid backlog issue/,
  );
});

test("only missing issues are planned; repeated imports plan zero", () => {
  const source = [
    { id: "P1-01", title: "[P1-01] One", body: "One" },
    { id: "P1-02", title: "[P1-02] Two", body: "Two" },
  ];
  const remote = [{ title: "[P1-01] One" }];
  assert.deepEqual(
    planImport(source, remote).map((issue) => issue.id),
    ["P1-02"],
  );
  assert.deepEqual(planImport(source, [...remote, { title: "[P1-02] Two" }]), []);
});

test("detects duplicate remote IDs instead of silently hiding them", () => {
  const existing = [{ title: "[P1-01] A" }, { title: "[P1-01] B" }];
  assert.throws(() => planImport([], existing), /Duplicate GitHub issue ID/);
});

test("ignores pull requests returned by the GitHub Issues API", () => {
  const issue = { id: "P2-01", title: "[P2-01] Work", body: "Body" };
  const remote = [{ title: "[P2-01] PR", pull_request: { url: "https://api.github.com/" } }];
  assert.equal(planImport([issue], remote).length, 1);
});
