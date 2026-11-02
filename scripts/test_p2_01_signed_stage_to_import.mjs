import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareDormantSourceExport } from "../apps/worker/dist/source-registry-export.js";
import { sealDormantSourceExport } from "../apps/worker/dist/source-export-signature.js";
import { stageOnce, verifyStage } from "./p2_01_signed_handoff_stage.mjs";

// This test uses actual Linux UIDs and a real worker-import function compiled
// from the production TypeScript. It never accesses a real host path, network,
// operator secret, external anchor or real news source.
const RUN = process.env.CI === "true" && process.getuid?.() === 0;
const policy = { enabled: true, hosts: ["news.example.org"] };
const source = {
  id: "synthetic_handoff",
  baseUrl: "https://news.example.org/rss/",
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Disposable fixture; no real provider usage rights implied.",
  reviewedAt: "2026-10-26",
};
const workerModule = new URL("../apps/worker/dist/source-export-files.js", import.meta.url).href;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vns-handoff-full-"));
  const view = mkdtempSync(join(tmpdir(), "vns-handoff-worker-view-"));
  chmodSync(view, 0o755);
  const parent = join(root, "videonews-studio");
  const base = join(parent, "p2-signed-source");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(base, { mode: 0o700 });
  const p = (name) => join(base, name);
  for (const [name, uid, gid] of [
    ["publisher", 10001, 10001],
    ["trust-material", 0, 0],
    ["worker-inbox", 10002, 10002],
    ["worker-checkpoint", 10002, 10002],
  ]) {
    mkdirSync(p(name), { mode: 0o700 });
    chownSync(p(name), uid, gid);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bundle = prepareDormantSourceExport(
    { revision: 8, sources: [source] },
    { revision: 7, approvedHosts: ["news.example.org"] },
  );
  const signed = sealDormantSourceExport(bundle, policy, privateKey);
  const bytes = Buffer.from(JSON.stringify(signed));
  writeFileSync(p("publisher/source-export.signed.json"), bytes, { mode: 0o600 });
  chownSync(p("publisher/source-export.signed.json"), 10001, 10001);
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(p("trust-material/signing-public.pem"), publicPem, { mode: 0o440 });
  chownSync(p("trust-material/signing-public.pem"), 0, 10002);
  chmodSync(p("trust-material/signing-public.pem"), 0o440);

  const config = { parent, base, user: { publisher: 10001, worker: 10002, transfer: 10003 } };
  const stage = join(view, "source-handoff");
  const inbox = join(view, "feed-inbox");
  const pub = join(view, "pinned-public.pem");
  const checkpoint = join(view, "checkpoint");
  mkdirSync(inbox, { mode: 0o700 });
  chownSync(inbox, 10002, 10002);
  mkdirSync(checkpoint, { mode: 0o700 });
  chownSync(checkpoint, 10002, 10002);
  writeFileSync(pub, publicPem, { mode: 0o440 });
  chownSync(pub, 0, 10002);
  chmodSync(pub, 0o440);

  return {
    root,
    view,
    p,
    stage,
    inbox,
    pub,
    publicPem,
    checkpoint,
    config,
    bytes,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(view, { recursive: true, force: true });
    },
  };
}

function workerImport(f, expectedSuccess) {
  // No fake-injected importer or privileged caller. After switching to
  // worker UID/GID, use the actual compiled source-export-files contract.
  const code = `
    import assert from "node:assert/strict";
    import { readFileSync, openSync, closeSync } from "node:fs";
    import { createPublicKey } from "node:crypto";
    const [stage, inbox, keyPath, moduleUrl] = process.argv.slice(1);
    // GitHub's checkout is root-only from the disposable test process:
    // load only code before dropping privileges; ALL stage/inbox I/O and
    // the actual importer invocation happen after dropping to UID 10002.
    const { importSignedSourceHandoff } = await import(moduleUrl);
    process.setgroups([]);
    process.setgid(10002);
    process.setuid(10002);
    assert.equal(process.getuid(), 10002);
    assert.equal(process.getgid(), 10002);
    try {
      const fd = openSync(stage + "/source-export.signed.json", "r+");
      closeSync(fd);
      throw new Error("worker could modify handoff stage");
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    }
    const key = createPublicKey(readFileSync(keyPath));
    await importSignedSourceHandoff(
      stage, inbox, { enabled: true, hosts: ["news.example.org"] }, key
    );
    const file = readFileSync(inbox + "/source-export.signed.json");
    assert.ok(file.includes(Buffer.from("vns-source-export-ed25519-v1")));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, f.stage, f.inbox, f.pub, workerModule],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status === 0, expectedSuccess, "Worker UID handoff result mismatched: " + result.stderr.slice(0, 1000));
  if (!expectedSuccess) assert.equal(result.stdout, "");
  return result;
}

test(
  "canonical signed publisher export stages byte-identically and imports under worker UID",
  {
    skip: !RUN,
  },
  () => {
    const f = fixture();
    try {
      stageOnce(f.config);
      verifyStage(f.config);
      renameSync(f.p("handoff-staging"), f.stage);
      const stageStat = statSync(f.stage);
      const fileStat = statSync(join(f.stage, "source-export.signed.json"));
      assert.deepEqual(
        [stageStat.uid, stageStat.gid, stageStat.mode & 0o777],
        [10003, 10002, 0o750],
      );
      assert.deepEqual([fileStat.uid, fileStat.gid, fileStat.mode & 0o777], [10003, 10002, 0o640]);
      assert.deepEqual(readFileSync(join(f.stage, "source-export.signed.json")), f.bytes);
      workerImport(f, true);
      const imported = join(f.inbox, "source-export.signed.json");
      assert.deepEqual(readFileSync(imported), f.bytes);
      const privateStat = statSync(imported);
      assert.deepEqual(
        [privateStat.uid, privateStat.gid, privateStat.mode & 0o777],
        [10002, 10002, 0o600],
      );
      assert.equal(existsSync(join(f.checkpoint, "source-export.checkpoint.json")), false);
      // Stage can be imported idempotently, without touching the independent
      // high-water or creating a checkpoint.
      workerImport(f, true);
      assert.deepEqual(readFileSync(imported), f.bytes);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "wrong key and tampered staged data cannot replace worker's private inbox",
  {
    skip: !RUN,
  },
  () => {
    const f = fixture();
    try {
      stageOnce(f.config);
      renameSync(f.p("handoff-staging"), f.stage);
      workerImport(f, true);
      const imported = join(f.inbox, "source-export.signed.json");
      const original = readFileSync(imported);
      const wrong = generateKeyPairSync("ed25519").publicKey;
      writeFileSync(f.pub, wrong.export({ type: "spki", format: "pem" }));
      workerImport(f, false);
      assert.deepEqual(readFileSync(imported), original);
      // Restore the independently pinned public key; then corrupt only stage.
      writeFileSync(f.pub, f.publicPem);
      writeFileSync(join(f.stage, "source-export.signed.json"), "tampered", {
        flag: "w",
      });
      workerImport(f, false);
      assert.deepEqual(readFileSync(imported), original);
      assert.equal(existsSync(join(f.checkpoint, "source-export.checkpoint.json")), false);
    } finally {
      f.cleanup();
    }
  },
);
