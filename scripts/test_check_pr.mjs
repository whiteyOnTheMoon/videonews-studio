import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function check(title, body) {
  return spawnSync(process.execPath, ["scripts/check_pr.mjs"], {
    env: { ...process.env, PR_TITLE: title, PR_BODY: body },
    encoding: "utf8",
  });
}

test("accepts project ID and closing reference", () => {
  assert.equal(check("[P1-02] Governance", "Closes #2").status, 0);
});

test("rejects missing title ID", () => {
  assert.notEqual(check("Governance", "Closes #2").status, 0);
});

test("rejects PR without issue reference", () => {
  assert.notEqual(check("[P1-02] Governance", "Some description").status, 0);
});
