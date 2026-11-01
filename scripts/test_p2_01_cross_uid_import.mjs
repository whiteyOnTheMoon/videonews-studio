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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareDormantSourceExport } from "../apps/worker/dist/source-registry-export.js";
import { sealDormantSourceExport } from "../apps/worker/dist/source-export-signature.js";

const POLICY = { enabled: true, hosts: ["news.example.org"] };
const SOURCE = {
  id: "synthetic_news",
  baseUrl: "https://news.example.org/rss/",
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic reviewed metadata-only usage for disposable tests.",
  reviewedAt: "2026-10-26",
};

function directory(path, mode, uid, gid) {
  mkdirSync(path, { mode });
  chownSync(path, uid, gid);
  chmodSync(path, mode);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vns-cross-uid-handoff-"));
  // Synthetic parent is searchable only to emulate independent Docker bind
  // mounts; the real production ancestor must remain root-owned mode 0700.
  chmodSync(root, 0o755);
  const publisher = join(root, "publisher");
  const stage = join(root, "stage");
  const inbox = join(root, "inbox");
  const checkpoint = join(root, "checkpoint");
  const publicKey = join(root, "pinned-public.pem");
  directory(publisher, 0o700, 10001, 10001);
  directory(stage, 0o750, 10003, 10002);
  directory(inbox, 0o700, 10002, 10002);
  directory(checkpoint, 0o700, 10002, 10002);

  const keys = generateKeyPairSync("ed25519");
  const bundle = prepareDormantSourceExport(
    { revision: 8, sources: [SOURCE] },
    { revision: 7, approvedHosts: POLICY.hosts },
  );
  const signed = sealDormantSourceExport(bundle, POLICY, keys.privateKey);
  const staged = join(stage, "source-export.signed.json");
  writeFileSync(staged, JSON.stringify(signed), { mode: 0o640 });
  chownSync(staged, 10003, 10002);
  chmodSync(staged, 0o640);

  const secret = join(publisher, "private-key.pem");
  writeFileSync(secret, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o400,
  });
  chownSync(secret, 10001, 10001);
  chmodSync(secret, 0o400);

  writeFileSync(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }), {
    mode: 0o440,
  });
  chownSync(publicKey, 0, 10002);
  chmodSync(publicKey, 0o440);
  return { root, publisher, stage, staged, inbox, checkpoint, publicKey, secret };
}

function runWorker(f, action) {
  // GitHub's ephemeral checkout may be private to the runner. The worker
  // image normally supplies readable compiled code; allow execute-only
  // traversal of the disposable runner path, never publisher data.
  const probe = fileURLToPath(new URL("./p2_01_cross_uid_import_probe.mjs", import.meta.url));
  for (let path = dirname(probe); path !== dirname(path); path = dirname(path)) {
    const info = statSync(path);
    if ((info.mode & 0o001) === 0) chmodSync(path, (info.mode & 0o777) | 0o001);
  }
  return spawnSync(process.execPath, [probe, f.root, action], {
    cwd: process.cwd(),
    uid: 10002,
    gid: 10002,
    encoding: "utf8",
    timeout: 15000,
    env: { PATH: process.env.PATH || "/usr/bin:/bin", CI: "true", NODE_ENV: "test" },
  });
}

const enabled =
  process.getuid?.() === 0 &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_REPOSITORY === "whiteyOnTheMoon/videonews-studio";

test(
  "signed transfer -> real separate worker UID -> private inbox -> anchored checkpoint",
  { skip: !enabled },
  () => {
    const f = fixture();
    try {
      const result = runWorker(f, "accept");
      assert.equal(result.status, 0, result.stderr || "Cross-UID signed handoff refused");
      const inbox = statSync(join(f.inbox, "source-export.signed.json"));
      const checkpoint = statSync(join(f.checkpoint, "source-export.checkpoint.json"));
      assert.deepEqual([inbox.uid, inbox.gid, inbox.mode & 0o777], [10002, 10002, 0o600]);
      assert.deepEqual(
        [checkpoint.uid, checkpoint.gid, checkpoint.mode & 0o777],
        [10002, 10002, 0o600],
      );
      assert.equal(
        readFileSync(f.staged).equals(readFileSync(join(f.inbox, "source-export.signed.json"))),
        true,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "tampered source envelope cannot cross UID handoff or create inbox",
  { skip: !enabled },
  () => {
    const f = fixture();
    try {
      const doc = JSON.parse(readFileSync(f.staged, "utf8"));
      doc.export.sourceRevision = 9;
      writeFileSync(f.staged, JSON.stringify(doc));
      const result = runWorker(f, "refuse");
      assert.equal(result.status, 0, result.stderr || "Tampered signature accepted");
      assert.equal(existsSync(join(f.inbox, "source-export.signed.json")), false);
      assert.equal(existsSync(join(f.checkpoint, "source-export.checkpoint.json")), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
