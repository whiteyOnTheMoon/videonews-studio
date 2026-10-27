import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { attestFeedSourceAnchorIdentity } from "./feed-source-anchor-identity.js";

const login = "vns_anchor_login_worker";
const allowed = {
  session_user: login,
  can_advance: true,
  can_read_anchor: false,
  superuser: false,
  create_role: false,
  create_db: false,
  replication: false,
  bypass_rls: false,
};

function db(rows: unknown[]): Pick<Pool, "query"> {
  return {
    async query(sql: string) {
      assert.match(sql, /session_user/);
      assert.match(sql, /vns_source_anchor[.]advance/);
      return { rows };
    },
  } as unknown as Pick<Pool, "query">;
}

test("independent source anchor login has only the monotonic advance function", async () => {
  await attestFeedSourceAnchorIdentity(db([allowed]), login);
  await assert.rejects(
    attestFeedSourceAnchorIdentity(db([allowed]), "postgres"),
    /identity refused/,
  );
  for (const key of [
    "can_advance",
    "can_read_anchor",
    "superuser",
    "create_role",
    "create_db",
    "replication",
    "bypass_rls",
  ]) {
    const bad = {
      ...allowed,
      [key]: key === "can_advance" ? false : true,
    };
    await assert.rejects(
      attestFeedSourceAnchorIdentity(db([bad]), login),
      /admission denied/,
    );
  }
  await assert.rejects(
    attestFeedSourceAnchorIdentity(db([{ ...allowed, session_user: "other" }]), login),
    /admission denied/,
  );
  await assert.rejects(attestFeedSourceAnchorIdentity(db([]), login), /admission denied/);
});

test("anchor outage and malformed data fail closed without exposing credentials", async () => {
  const dbPort = {
    async query(): Promise<never> {
      throw new Error("PRIVATE_SOURCE_ANCHOR_PASSWORD");
    },
  } as unknown as Pick<Pool, "query">;
  await assert.rejects(
    attestFeedSourceAnchorIdentity(dbPort, login),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Independent feed source anchor admission denied",
  );
});
