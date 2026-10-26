import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptDormantSourceFile,
  publishDormantSourceFile,
  type IndependentSourceRevisionAnchor,
  type SourceRevisionAnchorState,
} from "./source-export-files.js";
import {
  sealDormantSourceExport,
  verifyDormantSourceSignature,
} from "./source-export-signature.js";
import { prepareDormantSourceExport } from "./source-registry-export.js";

const policy = { enabled: true as const, hosts: ["news.example.org"] };
const source = {
  id: "sample_news",
  baseUrl: "https://news.example.org/feed/",
  status: "approved" as const,
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic fixture, independently audited rights.",
  reviewedAt: "2026-10-26",
};
const blocked = {
  ...source,
  id: "blocked_news",
  baseUrl: "https://news.example.org/feed/private/",
  status: "blocked" as const,
};
const defaultBundle = prepareDormantSourceExport(
  { revision: 8, sources: [source, blocked] },
  { revision: 3, approvedHosts: ["news.example.org"] },
);
async function paths() {
  const root = await mkdtemp(join(tmpdir(), "vns-signed-export-"));
  const publisher = join(root, "publisher");
  const consumer = join(root, "consumer");
  await mkdir(publisher, { mode: 0o700 });
  await mkdir(consumer, { mode: 0o700 });
  return { root, publisher, consumer };
}
async function cleanup(root: string) {
  await rm(root, { force: true, recursive: true });
}
function pair() {
  return generateKeyPairSync("ed25519");
}

test("a distinct public key verifies the export; altered envelope is refused", () => {
  const keys = pair();
  const sealed = sealDormantSourceExport(defaultBundle, policy, keys.privateKey);
  const accepted = verifyDormantSourceSignature(sealed, policy, keys.publicKey, {
    sourceRevision: 8,
    hostApprovalRevision: 3,
  });
  assert.equal(accepted.sources.length, 2);
  const wrongKeys = pair();
  assert.throws(() => verifyDormantSourceSignature(sealed, policy, wrongKeys.publicKey));
  assert.throws(() =>
    verifyDormantSourceSignature(
      sealed,
      {
        enabled: true,
        hosts: ["other.example.org"],
      },
      keys.publicKey,
    ),
  );
  for (const tampered of [
    { ...sealed, signature: "A".repeat(86) },
    { ...sealed, signature: sealed.signature + "=" },
    { ...sealed, export: { ...sealed.export, sourceRevision: 9 } },
    { ...sealed, apiKey: "synthetic" },
    { ...sealed, format: "unknown" },
  ]) {
    assert.throws(() => verifyDormantSourceSignature(tampered, policy, keys.publicKey));
  }
  assert.throws(() => sealDormantSourceExport(defaultBundle, policy, keys.publicKey));
});

test("offline publication fsyncs private file; consumer needs explicit initial bootstrap", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    const published = join(publisher, "source-export.signed.json");
    assert.equal((await lstat(published)).mode & 0o077, 0);
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey),
      /checkpoint absent/,
    );
    const sources = await acceptDormantSourceFile(
      publisher,
      consumer,
      policy,
      keys.publicKey,
      true,
    );
    assert.equal(sources.length, 2);
    assert.equal((await lstat(join(consumer, "source-export.checkpoint.json"))).mode & 0o077, 0);
    assert.equal(
      (await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey)).length,
      2,
    );
    const checkpoint = JSON.parse(
      await readFile(join(consumer, "source-export.checkpoint.json"), "utf8"),
    ) as { sourceRevision: number; hostApprovalRevision: number };
    assert.equal(checkpoint.sourceRevision, 8);
    assert.equal(checkpoint.hostApprovalRevision, 3);
    await rm(join(consumer, "source-export.checkpoint.json"));
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey),
      /checkpoint absent/,
    );
  } finally {
    await cleanup(root);
  }
});

test("persisted high-water checkpoint rejects a replayed signed older revision", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    const old = await readFile(join(publisher, "source-export.signed.json"));
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true);
    const newer = prepareDormantSourceExport(
      { revision: 9, sources: [source, blocked] },
      { revision: 4, approvedHosts: ["news.example.org"] },
    );
    await publishDormantSourceFile(publisher, newer, policy, keys.privateKey);
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey);
    await assert.rejects(
      publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey),
      /rollback/,
    );
    await writeFile(join(publisher, "source-export.signed.json"), old);
    await assert.rejects(acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey));
  } finally {
    await cleanup(root);
  }
});

test("same revision with changed contents is refused by both publisher and worker", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true);
    const changed = prepareDormantSourceExport(
      {
        revision: 8,
        sources: [
          source,
          blocked,
          {
            ...source,
            id: "pending_review",
            baseUrl: "https://news.example.org/feed/unreviewed/",
            status: "pending" as const,
          },
        ],
      },
      { revision: 3, approvedHosts: ["news.example.org"] },
    );
    await assert.rejects(
      publishDormantSourceFile(publisher, changed, policy, keys.privateKey),
      /equivocation/,
    );
    const sealed = sealDormantSourceExport(changed, policy, keys.privateKey);
    await writeFile(join(publisher, "source-export.signed.json"), JSON.stringify(sealed));
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey),
      /equivocation/,
    );
  } finally {
    await cleanup(root);
  }
});

test("stale exclusive locks, untrusted folders, and symlink files fail closed", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    await mkdir(join(publisher, ".publisher.lock"), { mode: 0o700 });
    await assert.rejects(
      publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey),
      /lock busy/,
    );
    await rm(join(publisher, ".publisher.lock"), { recursive: true });
    await chmod(publisher, 0o777);
    await assert.rejects(
      publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey),
      /not private/,
    );
    await chmod(publisher, 0o700);
    await symlink(join(root, "nowhere"), join(publisher, "source-export.signed.json"));
    await assert.rejects(
      publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey),
    );
    await rm(join(publisher, "source-export.signed.json"));
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    await mkdir(join(consumer, ".consumer.lock"));
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true),
      /lock busy/,
    );
    await rm(join(consumer, ".consumer.lock"), { recursive: true });
    const handle = await open(join(publisher, "source-export.signed.json"), constants.O_WRONLY);
    await handle.close();
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true);
  } finally {
    await cleanup(root);
  }
});

test("independent anchor refuses joint signed-export and checkpoint rollback", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    let highWater: SourceRevisionAnchorState | undefined;
    const anchor: IndependentSourceRevisionAnchor = {
      async advance(candidate) {
        if (highWater && candidate.sourceRevision < highWater.sourceRevision) {
          throw new Error("Independent anchor rejects rollback");
        }
        if (highWater && candidate.hostApprovalRevision < highWater.hostApprovalRevision) {
          throw new Error("Independent anchor rejects rollback");
        }
        if (
          highWater &&
          candidate.sourceRevision === highWater.sourceRevision &&
          candidate.hostApprovalRevision === highWater.hostApprovalRevision &&
          candidate.envelopeSha256 !== highWater.envelopeSha256
        ) {
          throw new Error("Independent anchor rejects equivocation");
        }
        highWater = { ...candidate };
      },
    };
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true, anchor);
    const oldExport = await readFile(join(publisher, "source-export.signed.json"));
    const oldCheckpoint = await readFile(join(consumer, "source-export.checkpoint.json"));
    const newer = prepareDormantSourceExport(
      { revision: 9, sources: [source, blocked] },
      { revision: 4, approvedHosts: ["news.example.org"] },
    );
    await publishDormantSourceFile(publisher, newer, policy, keys.privateKey);
    await acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, false, anchor);
    await writeFile(join(publisher, "source-export.signed.json"), oldExport);
    await writeFile(join(consumer, "source-export.checkpoint.json"), oldCheckpoint);
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, false, anchor),
      /Independent anchor rejects rollback/,
    );
  } finally {
    await cleanup(root);
  }
});

test("anchor error prevents checkpoint creation and source release", async () => {
  const { root, publisher, consumer } = await paths();
  try {
    const keys = pair();
    await publishDormantSourceFile(publisher, defaultBundle, policy, keys.privateKey);
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, keys.publicKey, true, {
        async advance() {
          throw new Error("independent store unavailable");
        },
      }),
      /independent store unavailable/,
    );
    await assert.rejects(lstat(join(consumer, "source-export.checkpoint.json")), {
      code: "ENOENT",
    });
  } finally {
    await cleanup(root);
  }
});
