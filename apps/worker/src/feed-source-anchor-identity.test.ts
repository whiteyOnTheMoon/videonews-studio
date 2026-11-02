import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { attestFeedSourceAnchorIdentity } from "./feed-source-anchor-identity.js";

const login = "vns_anchor_login_worker";
const allowed = {
  session_user: login,
  can_advance: true,
  can_advance_trust_policy: true,
  can_read_anchor: false,
  can_write_anchor: false,
  can_read_policy_anchor: false,
  can_write_policy_anchor: false,
  can_read_trust_approvals: false,
  can_write_trust_approvals: false,
  can_assume_authority_owner: false,
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
      assert.match(sql, /vns_source_anchor[.]advance_trust_policy/);
      assert.match(sql, /vns_source_anchor[.]trust_policy_approvals/);
      assert.match(sql, /can_write_anchor/);
      assert.match(sql, /can_write_policy_anchor/);
      assert.match(sql, /pg_has_role/);
      assert.match(sql, /can_assume_authority_owner/);
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
    "can_advance_trust_policy",
    "can_read_anchor",
    "can_write_anchor",
    "can_read_policy_anchor",
    "can_write_policy_anchor",
    "can_read_trust_approvals",
    "can_write_trust_approvals",
    "can_assume_authority_owner",
    "superuser",
    "create_role",
    "create_db",
    "replication",
    "bypass_rls",
  ]) {
    const bad = {
      ...allowed,
      [key]: ["can_advance", "can_advance_trust_policy"].includes(key) ? false : true,
    };
    await assert.rejects(attestFeedSourceAnchorIdentity(db([bad]), login), /admission denied/);
  }
  // Even a valid-looking LOGIN must be refused if it could write a
  // high-water row directly or assume the SECURITY DEFINER owner.
  for (const privilege of [
    "can_write_anchor",
    "can_write_policy_anchor",
    "can_write_trust_approvals",
    "can_assume_authority_owner",
  ] as const) {
    await assert.rejects(
      attestFeedSourceAnchorIdentity(db([{ ...allowed, [privilege]: true }]), login),
      /admission denied/,
    );
  }
  // A missing or nonboolean privilege result is never interpreted as false.
  await assert.rejects(
    attestFeedSourceAnchorIdentity(db([{ ...allowed, can_write_anchor: undefined }]), login),
    /admission denied/,
  );
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
      error instanceof Error && error.message === "Independent feed source anchor admission denied",
  );
});
