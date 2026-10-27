import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishApprovedAdminSourceFile } from "./postgres-admin-source-publisher.js";
import { acceptDormantSourceFile } from "./source-export-files.js";

const policy = { enabled: true as const, hosts: ["news.example.org"] };
const parent = {
  id: "ci_export_parent",
  baseUrl: "https://news.example.org/rss/",
  status: "approved" as const,
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic source rights, independently reviewed.",
  reviewedAt: "2026-10-26",
};
const blocked = {
  ...parent,
  id: "ci_export_blocked",
  baseUrl: "https://news.example.org/rss/private/",
  status: "blocked" as const,
};
const snapshot = {
  sourceSnapshot: { revision: 8, sources: [parent, blocked] },
  hostApproval: { revision: 3, approvedHosts: ["news.example.org"] },
};
async function directories() {
  const root = await mkdtemp(join(tmpdir(), "vns-atomic-source-db-"));
  const publisher = join(root, "publisher");
  const consumer = join(root, "consumer");
  await mkdir(publisher, { mode: 0o700 });
  await mkdir(consumer, { mode: 0o700 });
  return { root, publisher, consumer };
}

test("one locked DB projection is signed, atomically published and accepted", async () => {
  const { root, publisher, consumer } = await directories();
  try {
    const key = generateKeyPairSync("ed25519");
    let reads = 0;
    const db = {
      async query(sql: string) {
        assert.equal(sql, "SELECT vns.read_approved_source_export() AS snapshot");
        reads++;
        return { rows: [{ snapshot }] };
      },
    };
    const revision = await publishApprovedAdminSourceFile(
      db,
      publisher,
      policy,
      key.privateKey,
    );
    assert.deepEqual(revision, { sourceRevision: 8, hostApprovalRevision: 3 });
    assert.equal(reads, 1);
    let advances = 0;
    const sources = await acceptDormantSourceFile(
      publisher,
      consumer,
      policy,
      key.publicKey,
      true,
      {
        async advance(candidate) {
          advances++;
          assert.equal(candidate.sourceRevision, 8);
          assert.equal(candidate.hostApprovalRevision, 3);
        },
      },
    );
    assert.deepEqual(sources, [blocked, parent].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(advances, 1);
    const signed = JSON.parse(
      await readFile(join(publisher, "source-export.signed.json"), "utf8"),
    ) as { signature: string; export: { sourceRevision: number } };
    assert.equal(signed.export.sourceRevision, 8);
    await writeFile(
      join(publisher, "source-export.signed.json"),
      JSON.stringify({ ...signed, signature: "A".repeat(86) }),
    );
    await assert.rejects(
      acceptDormantSourceFile(publisher, consumer, policy, key.publicKey),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot mismatch, SQL failure and malformed responses never publish", async () => {
  const { root, publisher } = await directories();
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const invalid = [
      [],
      [{ snapshot: null }],
      [{ snapshot: { ...snapshot, unknown: true } }],
      [{ snapshot: { ...snapshot, hostApproval: { revision: 3, approvedHosts: [] } } }],
      [{ snapshot: { ...snapshot, hostApproval: { revision: 0, approvedHosts: [] } } }],
      [{ snapshot: { ...snapshot, sourceSnapshot: { revision: 8, sources: [blocked] } } }],
      [{ snapshot }, { snapshot }],
    ];
    for (const rows of invalid) {
      await assert.rejects(
        publishApprovedAdminSourceFile(
          { async query() { return { rows }; } },
          publisher,
          policy,
          privateKey,
        ),
        /Approved signed source publication unavailable/,
      );
    }
    await assert.rejects(
      publishApprovedAdminSourceFile(
        { async query(): Promise<never> { throw new Error("PRIVATE_DB_SECRET"); } },
        publisher,
        policy,
        privateKey,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Approved signed source publication unavailable",
    );
    await assert.rejects(readFile(join(publisher, "source-export.signed.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
