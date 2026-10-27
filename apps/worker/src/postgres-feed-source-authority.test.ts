import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresFeedSourceAuthority } from "./postgres-feed-source-authority.js";
import type { RegisteredResearchSource } from "./source-registry.js";

const source: RegisteredResearchSource = {
  id: "rss_authority",
  baseUrl: "https://source.example.org/rss/",
  access: "rss",
  status: "approved",
  intervalMinutes: 60,
  termsUrl: "https://source.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic approved metadata only.",
  reviewedAt: "2026-10-26",
};

test("source admission uses parameterized SQL and exact source snapshot", async () => {
  let approved = true;
  const db = {
    async query(sql: string, params: unknown[]) {
      assert.equal(sql, "SELECT vns.feed_runtime_source_authorized($1::jsonb) AS authorized");
      assert.deepEqual(JSON.parse(String(params[0])), source);
      return { rows: [{ authorized: approved }] };
    },
  } as unknown as Pool;
  const authority = new PostgresFeedSourceAuthority(db);
  assert.equal(await authority.admitted(source), true);
  approved = false;
  assert.equal(await authority.admitted(source), false);
  assert.equal(await authority.admitted({ ...source, status: "blocked" }), false);
});

test("database outage or malformed responses fail closed without leaking details", async () => {
  for (const rows of [
    [],
    [{ authorized: "true" }],
    [{ authorized: true }, { authorized: false }],
  ]) {
    const db = {
      async query() {
        return { rows };
      },
    } as unknown as Pool;
    const authority = new PostgresFeedSourceAuthority(db);
    await assert.rejects(authority.admitted(source), /Feed source authority unavailable/);
  }
  const outage = new PostgresFeedSourceAuthority({
    async query(): Promise<never> {
      throw new Error("SECRET_DB_PASSWORD");
    },
  } as unknown as Pool);
  await assert.rejects(
    outage.admitted(source),
    (error: unknown) =>
      error instanceof Error && error.message === "Feed source authority unavailable",
  );
});
