// Disposable CI-only child process for the actual source handoff importer.
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { importSignedSourceHandoff, acceptDormantSourceFile } from "../apps/worker/dist/source-export-files.js";

async function main() {
  assert.equal(process.env.CI, "true");
  assert.equal(process.getuid?.(), 10002);
  assert.equal(process.getgid?.(), 10002);
  assert.equal(process.argv.length, 4);
  const [root, action] = process.argv.slice(2);
  assert.ok(["accept", "refuse"].includes(action));
  const policy = { enabled: true, hosts: ["news.example.org"] };
  const stage = join(root, "stage");
  const inbox = join(root, "inbox");
  const checkpoint = join(root, "checkpoint");
  // This is a real OS access-control check, not a stub.
  assert.throws(
    () => readFileSync(join(root, "publisher/private-key.pem")),
    { code: "EACCES" },
  );
  const publicKey = createPublicKey(readFileSync(join(root, "pinned-public.pem")));
  if (action === "refuse") {
    await assert.rejects(importSignedSourceHandoff(stage, inbox, policy, publicKey));
    return;
  }
  const imported = await importSignedSourceHandoff(stage, inbox, policy, publicKey);
  assert.deepEqual(imported, { sourceRevision: 8, hostApprovalRevision: 7 });
  assert.equal(statSync(join(inbox, "source-export.signed.json")).mode & 0o777, 0o600);
  await assert.rejects(
    acceptDormantSourceFile(inbox, checkpoint, policy, publicKey),
    /checkpoint absent/,
  );
  let advances = 0;
  const sources = await acceptDormantSourceFile(inbox, checkpoint, policy, publicKey, true, {
    async advance(candidate) {
      advances++;
      assert.deepEqual(
        [candidate.sourceRevision, candidate.hostApprovalRevision],
        [8, 7],
      );
      assert.match(candidate.envelopeSha256, /^[a-f0-9]{64}$/);
    },
  });
  assert.equal(advances, 1);
  assert.equal(sources.length, 1);
  assert.equal(statSync(join(checkpoint, "source-export.checkpoint.json")).mode & 0o777, 0o600);
}

try {
  await main();
} catch {
  console.error("REFUSED: isolated source import CI probe failed");
  process.exitCode = 2;
}
