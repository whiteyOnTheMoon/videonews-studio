import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importSignedSourceHandoff, acceptDormantSourceFile, publishDormantSourceFile } from "./source-export-files.js";
import { prepareDormantSourceExport } from "./source-registry-export.js";
import { readSourceHandoffAdmission } from "./source-handoff-import-once.js";

const policy = { enabled: true as const, hosts: ["news.example.org"] };
const source = {
  id: "handoff_news",
  baseUrl: "https://news.example.org/rss/",
  status: "approved" as const,
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic reviewed rights fixture.",
  reviewedAt: "2026-10-26",
};
const bundle = (sourceRevision: number, hostApprovalRevision: number) =>
  prepareDormantSourceExport(
    { revision: sourceRevision, sources: [source] },
    { revision: hostApprovalRevision, approvedHosts: ["news.example.org"] },
  );

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vns-source-handoff-"));
  const publisher = join(root, "publisher");
  const staging = join(root, "staging");
  const inbox = join(root, "inbox");
  const checkpoint = join(root, "checkpoint");
  await mkdir(publisher, { mode: 0o700 });
  await mkdir(staging, { mode: 0o750 });
  await mkdir(inbox, { mode: 0o700 });
  await mkdir(checkpoint, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  await publishDormantSourceFile(publisher, bundle(8, 3), policy, keys.privateKey);
  const staged = join(staging, "source-export.signed.json");
  await copyFile(join(publisher, "source-export.signed.json"), staged);
  await chmod(staged, 0o640);
  return { root, publisher, staging, staged, inbox, checkpoint, keys };
}

test("read-only staged signed file becomes a private 0600 inbox and independently anchored source", async () => {
  const f = await fixture();
  try {
    const imported = await importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey);
    assert.deepEqual(imported, { sourceRevision: 8, hostApprovalRevision: 3 });
    const privateFile = join(f.inbox, "source-export.signed.json");
    assert.equal((await lstat(privateFile)).mode & 0o077, 0);
    let advances = 0;
    const sources = await acceptDormantSourceFile(
      f.inbox, f.checkpoint, policy, f.keys.publicKey, true,
      { async advance(candidate) {
        advances++;
        assert.equal(candidate.sourceRevision, 8);
        assert.equal(candidate.hostApprovalRevision, 3);
      } },
    );
    assert.deepEqual(sources, [source]);
    assert.equal(advances, 1);
    assert.deepEqual(
      await importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey),
      imported,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rollback, same-revision equivocation and tampered signatures never replace the inbox", async () => {
  const f = await fixture();
  try {
    await importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey);
    const old = await readFile(f.staged);
    await publishDormantSourceFile(f.publisher, bundle(9, 4), policy, f.keys.privateKey);
    await copyFile(join(f.publisher, "source-export.signed.json"), f.staged);
    await chmod(f.staged, 0o640);
    await importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey);
    const current = await readFile(join(f.inbox, "source-export.signed.json"));
    await writeFile(f.staged, old);
    await assert.rejects(
      importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey),
      /rollback/,
    );
    assert.deepEqual(await readFile(join(f.inbox, "source-export.signed.json")), current);
    const altered = JSON.parse(old.toString("utf8")) as Record<string, unknown>;
    await writeFile(f.staged, JSON.stringify({ ...altered, signature: "A".repeat(86) }));
    await assert.rejects(importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey));
    assert.deepEqual(await readFile(join(f.inbox, "source-export.signed.json")), current);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("handoff denies public, group-writable, symlinked or non-readable staging", async () => {
  const f = await fixture();
  try {
    await chmod(f.staging, 0o777);
    await assert.rejects(importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey));
    await chmod(f.staging, 0o750);
    await chmod(f.staged, 0o666);
    await assert.rejects(importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey));
    await chmod(f.staged, 0o600);
    await assert.rejects(importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey));
    await rm(f.staged);
    await symlink(join(f.publisher, "source-export.signed.json"), f.staged);
    await assert.rejects(importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey));
    await rm(f.staged);
    await copyFile(join(f.publisher, "source-export.signed.json"), f.staged);
    await chmod(f.staged, 0o640);
    await mkdir(join(f.inbox, ".consumer.lock"), { mode: 0o700 });
    await assert.rejects(
      importSignedSourceHandoff(f.staging, f.inbox, policy, f.keys.publicKey),
      /lock busy/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("standalone handoff remains disabled unless operator gates and exact paths are present", () => {
  const env: NodeJS.ProcessEnv = {
    VNS_SOURCE_HANDOFF_ENABLED: "true",
    VNS_SOURCE_HANDOFF_OPERATOR_ACK: "true",
    VNS_SOURCE_HANDOFF_MODE: "single_pass",
    VNS_SOURCE_HANDOFF_STAGING: "/var/lib/vns/source-handoff",
    VNS_FEED_SIGNED_SOURCE_INBOX: "/var/lib/vns/feed-source-inbox",
    VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/run/secrets/vns_feed_source_public_key",
    VNS_SOURCE_FETCH_ENABLED: "true",
    VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
  };
  assert.equal(readSourceHandoffAdmission(env).staging, "/var/lib/vns/source-handoff");
  for (const key of Object.keys(env)) {
    assert.throws(() => readSourceHandoffAdmission({ ...env, [key]: undefined }), key);
  }
  for (const extra of [
    { VNS_SOURCE_HANDOFF_MODE: "repeat" },
    { VNS_SOURCE_HANDOFF_STAGING: "/tmp/staged" },
    { VNS_FEED_SIGNED_SOURCE_INBOX: "/tmp/inbox" },
    { VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/tmp/fake" },
    { VNS_ALLOWED_SOURCE_HOSTS: "evil.example.org,evil.example.org" },
  ]) {
    assert.throws(() => readSourceHandoffAdmission({ ...env, ...extra }));
  }
});
