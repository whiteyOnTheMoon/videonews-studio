// Read-only synthetic archive-manifest adversarial tests: GitHub Actions only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCiAofInventory,
  inspectCiAofArchive,
  verifyCiAofInventory,
} from "./ci_aof_archive_preflight.mjs";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
  process.env.VNS_CI_AOF_DRILL !== "true"
) {
  throw new Error("REFUSED: disposable CI archive adversarial tests only");
}

const BASE = "appendonly.aof.1.base.rdb";
const INCR = "appendonly.aof.1.incr.aof";
const MANIFEST = "appendonly.aof.manifest";
const validManifest = () =>
  "file " + BASE + " seq 1 type b\nfile " + INCR + " seq 1 type i\n";

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "vns-ci-aof-preflight-"));
  const source = join(folder, "source");
  const parts = join(source, "appendonlydir");
  const inventory = join(folder, "independent-inventory.json");
  await mkdir(parts, { recursive: true });
  await writeFile(join(parts, BASE), "synthetic-base-rdb");
  await writeFile(join(parts, INCR), "synthetic-incremental-aof");
  await writeFile(join(parts, MANIFEST), validManifest());
  return {
    folder,
    source,
    parts,
    inventory,
    dispose: () => rm(folder, { recursive: true, force: true }),
  };
}

test("accepts a stopped synthetic Redis multipart AOF with separate inventory", async () => {
  const f = await fixture();
  try {
    const original = await createCiAofInventory(f.source, f.inventory);
    assert.equal(original.files.length, 3);
    assert.deepEqual(await verifyCiAofInventory(f.source, f.inventory), original);
    await assert.rejects(createCiAofInventory(f.source, f.inventory), /EEXIST/);
  } finally {
    await f.dispose();
  }
});

const mutations = [
  ["changed AOF bytes", async (f) => writeFile(join(f.parts, INCR), "altered-aof")],
  ["removed base segment", async (f) => rm(join(f.parts, BASE))],
  ["unlisted extra file", async (f) => writeFile(join(f.parts, "unlisted.txt"), "extra")],
  [
    "unlisted manifest segment",
    async (f) =>
      writeFile(
        join(f.parts, MANIFEST),
        validManifest() + "file appendonly.aof.2.incr.aof seq 2 type i\n",
      ),
  ],
  [
    "manifest traversal",
    async (f) =>
      writeFile(
        join(f.parts, MANIFEST),
        "file ../bad.rdb seq 1 type b\nfile " + INCR + " seq 1 type i\n",
      ),
  ],
  [
    "duplicate segment",
    async (f) =>
      writeFile(join(f.parts, MANIFEST), validManifest() + "file " + INCR + " seq 1 type i\n"),
  ],
  [
    "manifest sequence mismatch",
    async (f) =>
      writeFile(
        join(f.parts, MANIFEST),
        "file " + BASE + " seq 2 type b\nfile " + INCR + " seq 1 type i\n",
      ),
  ],
  [
    "symlink segment",
    async (f) => {
      const path = join(f.parts, BASE);
      const copy = join(f.folder, "external-file");
      await writeFile(copy, "outside");
      await rm(path);
      await symlink(copy, path);
    },
  ],
];

for (const [name, mutate] of mutations) {
  test("rejects " + name + " before Redis can run", async () => {
    const f = await fixture();
    try {
      await createCiAofInventory(f.source, f.inventory);
      await mutate(f);
      await assert.rejects(verifyCiAofInventory(f.source, f.inventory));
    } finally {
      await f.dispose();
    }
  });
}

test("refuses forged SHA-256 inventory and nested inventory destination", async () => {
  const f = await fixture();
  try {
    await createCiAofInventory(f.source, f.inventory);
    const original = JSON.parse(await readFile(f.inventory, "utf8"));
    original.files[0].sha256 = "0".repeat(64);
    await writeFile(f.inventory, JSON.stringify(original));
    await assert.rejects(verifyCiAofInventory(f.source, f.inventory));
    await assert.rejects(createCiAofInventory(f.source, join(f.source, "inventory.json")));
  } finally {
    await f.dispose();
  }
});

test("refuses inspection when GitHub recovery-test gate is off", async () => {
  const f = await fixture();
  const original = process.env.VNS_CI_AOF_DRILL;
  process.env.VNS_CI_AOF_DRILL = "false";
  try {
    await assert.rejects(inspectCiAofArchive(f.source), /Disposable AOF drill only/);
  } finally {
    process.env.VNS_CI_AOF_DRILL = original;
    await f.dispose();
  }
});
