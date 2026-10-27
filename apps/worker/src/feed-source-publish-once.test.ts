import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  attestSourcePublisherIdentity,
  readSourcePublisherAdmission,
} from "./feed-source-publish-once.js";

const env: NodeJS.ProcessEnv = {
  VNS_SOURCE_PUBLISHER_ENABLED: "true",
  VNS_SOURCE_PUBLISHER_OPERATOR_ACK: "true",
  VNS_SOURCE_PUBLISHER_RIGHTS_ATTESTED: "true",
  VNS_SOURCE_PUBLISHER_MODE: "single_pass",
  VNS_SOURCE_EXPORT_DB_HOST: "postgres",
  VNS_SOURCE_EXPORT_DB_USER: "vns_source_export_login_publisher",
  VNS_SOURCE_EXPORT_DB_PASSWORD_FILE: "/run/secrets/vns_source_export_db_password",
  VNS_SOURCE_EXPORT_SIGNING_KEY_FILE: "/run/secrets/vns_source_export_signing_key",
  VNS_SOURCE_EXPORT_DIRECTORY: "/var/lib/vns/source-publisher",
  VNS_SOURCE_EXPORT_APPROVED_HOSTS: "news.example.org",
};

test("source publisher admission rejects missing approvals, mutable paths and arbitrary DB logins", () => {
  const admission = readSourcePublisherAdmission(env);
  assert.equal(admission.dbLogin, "vns_source_export_login_publisher");
  assert.equal(admission.directory, "/var/lib/vns/source-publisher");
  for (const field of [
    "VNS_SOURCE_PUBLISHER_ENABLED",
    "VNS_SOURCE_PUBLISHER_OPERATOR_ACK",
    "VNS_SOURCE_PUBLISHER_RIGHTS_ATTESTED",
    "VNS_SOURCE_PUBLISHER_MODE",
    "VNS_SOURCE_EXPORT_DB_HOST",
    "VNS_SOURCE_EXPORT_DB_USER",
    "VNS_SOURCE_EXPORT_DB_PASSWORD_FILE",
    "VNS_SOURCE_EXPORT_SIGNING_KEY_FILE",
    "VNS_SOURCE_EXPORT_DIRECTORY",
    "VNS_SOURCE_EXPORT_APPROVED_HOSTS",
  ]) {
    assert.throws(() => readSourcePublisherAdmission({ ...env, [field]: undefined }), field);
  }
  for (const change of [
    { VNS_SOURCE_PUBLISHER_MODE: "cron" },
    { VNS_SOURCE_EXPORT_DB_HOST: "evil.example.org" },
    { VNS_SOURCE_EXPORT_DB_USER: "postgres" },
    { VNS_SOURCE_EXPORT_DB_USER: "vns_feed_login_worker" },
    { VNS_SOURCE_EXPORT_DIRECTORY: "/tmp/unsafe" },
    { VNS_SOURCE_EXPORT_SIGNING_KEY_FILE: "/tmp/unsafe" },
    { VNS_SOURCE_EXPORT_APPROVED_HOSTS: "localhost" },
    { VNS_SOURCE_EXPORT_APPROVED_HOSTS: "news.example.org,news.example.org" },
  ]) {
    assert.throws(() => readSourcePublisherAdmission({ ...env, ...change }));
  }
  assert.throws(() => readSourcePublisherAdmission({}), /not authorized/);
});

const login = "vns_source_export_login_publisher";
const allowed = {
  session_user: login,
  reader_member: true,
  can_read_export: true,
  can_read_sources: false,
  can_read_hosts: false,
  can_read_audit: false,
  can_edit_sources: false,
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
      assert.match(sql, /read_approved_source_export/);
      return { rows };
    },
  } as unknown as Pick<Pool, "query">;
}

test("publisher requires PostgreSQL authenticated least-privilege session_user", async () => {
  await attestSourcePublisherIdentity(db([allowed]), login);
  for (const field of [
    "reader_member",
    "can_read_export",
    "can_read_sources",
    "can_read_hosts",
    "can_read_audit",
    "can_edit_sources",
    "superuser",
    "create_role",
    "create_db",
    "replication",
    "bypass_rls",
  ]) {
    const bad = {
      ...allowed,
      [field]: field === "reader_member" || field === "can_read_export" ? false : true,
    };
    await assert.rejects(
      attestSourcePublisherIdentity(db([bad]), login),
      /database admission denied/,
      field,
    );
  }
  await assert.rejects(attestSourcePublisherIdentity(db([]), login), /admission denied/);
  await assert.rejects(
    attestSourcePublisherIdentity(db([{ ...allowed, session_user: "vns_source_export_login_other" }]), login),
    /admission denied/,
  );
  await assert.rejects(
    attestSourcePublisherIdentity(db([allowed]), "postgres"),
    /login refused/,
  );
});

test("publisher hides backend errors and never assumes failed SQL grants are valid", async () => {
  await assert.rejects(
    attestSourcePublisherIdentity(
      {
        async query(): Promise<never> {
          throw new Error("DATABASE_PASSWORD_SHOULD_NOT_LEAK");
        },
      } as unknown as Pick<Pool, "query">,
      login,
    ),
    (error: unknown) =>
      error instanceof Error && error.message === "Source publisher database admission denied",
  );
});
