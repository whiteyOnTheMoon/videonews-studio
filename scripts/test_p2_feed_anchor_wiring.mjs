import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("one-shot observer and durable consumer share the guarded anchor connector", async () => {
  for (const file of ["feed-observe-once.ts", "feed-trusted-context.ts"]) {
    const content = await readFile(new URL("../apps/worker/src/" + file, import.meta.url), "utf8");
    assert.match(content, /feedAnchorPoolConfig\(/);
    assert.doesNotMatch(content, /database:\s*"vns_source_anchor"/);
    assert.doesNotMatch(content, /ssl:\s*\{\s*ca/);
  }
});
