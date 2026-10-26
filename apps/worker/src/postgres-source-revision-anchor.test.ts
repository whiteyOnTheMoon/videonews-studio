import assert from "node:assert/strict";
import test from "node:test";
import {
  postgresSourceRevisionAnchor,
  type AnchorQuery,
} from "./postgres-source-revision-anchor.js";

const digest = "a".repeat(64);
const newer = { sourceRevision: 9, hostApprovalRevision: 4, envelopeSha256: digest };

test("anchor calls a single conditional PostgreSQL update without bootstrap", async () => {
  const calls: { sql: string; params: readonly (string | number)[] }[] = [];
  const db: AnchorQuery = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ accepted: true }] };
    },
  };
  await postgresSourceRevisionAnchor(db).advance(newer);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.sql,
    "SELECT vns_source_anchor.advance($1::bigint, $2::bigint, $3::text) AS accepted",
  );
  assert.deepEqual(calls[0]!.params, [9, 4, digest]);
});

test("missing bootstrap, rollback and inconsistent query result fail closed", async () => {
  for (const rowCount of [0, null, 2]) {
    const anchor = postgresSourceRevisionAnchor({
      async query() {
        return { rowCount, rows: [{ accepted: true }] };
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
  await assert.rejects(
    anchor.advance(newer),
    /^Error: Independent source revision admission refused$/,
  );
});

test("server rejection and ambiguous result never advance", async () => {
  for (const response of [
    { rowCount: 1, rows: [{ accepted: false }] },
    { rowCount: 1, rows: [{ accepted: "true" }] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ accepted: true }, { accepted: true }] },
  ]) {
    await assert.rejects(
      postgresSourceRevisionAnchor({ async query() { return response; } }).advance(newer),
      /admission refused/,
    );
  }
});
