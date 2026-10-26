import assert from "node:assert/strict";
import test from "node:test";
import { postgresSourceRevisionAnchor, type AnchorQuery } from "./postgres-source-revision-anchor.js";

const digest = "a".repeat(64);
const newer = { sourceRevision: 9, hostApprovalRevision: 4, envelopeSha256: digest };

test("anchor calls a single conditional PostgreSQL update without bootstrap", async () => {
  const calls: { sql: string; params: readonly (string | number)[] }[] = [];
  const db: AnchorQuery = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  await postgresSourceRevisionAnchor(db).advance(newer);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /UPDATE vns_source_anchor\.high_water/);
  assert.match(calls[0]!.sql, /source_revision <= \$1/);
  assert.match(calls[0]!.sql, /host_approval_revision <= \$2/);
  assert.match(calls[0]!.sql, /envelope_sha256 = \$3/);
  assert.match(calls[0]!.sql, /RETURNING anchor_id/);
  assert.deepEqual(calls[0]!.params, [9, 4, digest]);
});

test("missing bootstrap, rollback and inconsistent query result fail closed", async () => {
  for (const rowCount of [0, null, 2]) {
    const anchor = postgresSourceRevisionAnchor({
      async query() {
        return { rowCount };
      },
    });
    await assert.rejects(anchor.advance(newer), /admission refused/);
  }
});

test("invalid revisions and digest do not reach storage", async () => {
  const db: AnchorQuery = {
    async query() {
      throw new Error("must not be called");
    },
  };
  const anchor = postgresSourceRevisionAnchor(db);
  for (const invalid of [
    { ...newer, sourceRevision: -1 },
    { ...newer, sourceRevision: 1.5 },
    { ...newer, hostApprovalRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...newer, envelopeSha256: "BAD" },
  ]) {
    await assert.rejects(anchor.advance(invalid), /candidate invalid/);
  }
});

test("database outage is sanitized and does not return success", async () => {
  const anchor = postgresSourceRevisionAnchor({
    async query() {
      throw new Error("internal connection credential should not be disclosed");
    },
  });
  await assert.rejects(anchor.advance(newer), /^Error: Independent source revision admission refused$/);
});
