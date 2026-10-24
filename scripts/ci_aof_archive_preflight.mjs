// P1-07: local-only integrity and file-layout preflight for DISPOSABLE Redis 7 AOF.
// A SHA-256 inventory held beside its archive is NOT a trusted off-host anchor.
// Never use these CI helpers to authorize real backups or start workers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "appendonlydir/appendonly.aof.manifest";
const MAX_BYTES = 8_000_000;
const MAX_FILES = 12;
const SEGMENT = /^appendonly\.aof\.([1-9]\d*)\.(base\.rdb|base\.aof|incr\.aof)$/;

function ciOnly() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "CI only");
  assert.equal(process.env.CI, "true", "CI only");
  assert.equal(process.env.GITHUB_REPOSITORY, "whiteyOnTheMoon/videonews-studio");
  assert.equal(process.env.VNS_CI_AOF_DRILL, "true", "Disposable AOF drill only");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
}

async function ordinary(path, directory = false) {
  const stat = await lstat(path);
  assert.ok(!stat.isSymbolicLink(), "Symlink forbidden in AOF archive");
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), "Invalid AOF object kind");
  if (!directory) {
    assert.equal(stat.nlink, 1, "Hard-linked AOF file forbidden");
    assert.ok(stat.size > 0 && stat.size <= MAX_BYTES, "AOF file size out of bounds");
  }
  return stat;
}

async function filesOnly(directory) {
  return (await readdir(directory)).sort();
}

export async function inspectCiAofArchive(root) {
  ciOnly();
  assert.ok(resolve(root).startsWith("/tmp/"), "CI temp root only");
  await ordinary(root, true);
  assert.deepEqual(await filesOnly(root), ["appendonlydir"], "Unexpected AOF root entry");
  const part = join(root, "appendonlydir");
  await ordinary(part, true);
  const manifestBytes = await readFile(join(part, "appendonly.aof.manifest"));
  await ordinary(join(part, "appendonly.aof.manifest"));
  assert.ok(manifestBytes.length <= 4096, "Redis AOF manifest too large");
  const manifest = manifestBytes.toString("utf8");
  assert.ok(!manifest.includes("\r") && manifest.endsWith("\n"), "Bad AOF manifest encoding");
  const lines = manifest.trimEnd().split("\n");
  assert.ok(lines.length >= 2 && lines.length <= MAX_FILES - 1, "Unexpected AOF segment count");

  let base = 0;
  let incr = 0;
  const segments = new Set();
  for (const line of lines) {
    const match = /^file (\S+) seq ([1-9]\d*) type ([bi])$/.exec(line);
    assert.ok(match, "Unrecognized AOF manifest line");
    const filename = match[1];
    const segment = SEGMENT.exec(filename);
    assert.ok(segment, "Unsafe or unsupported AOF segment path");
    assert.equal(Number(segment[1]), Number(match[2]), "AOF sequence mismatch");
    assert.ok(!segments.has(filename), "Duplicate AOF segment");
    segments.add(filename);
    if (match[3] === "b") {
      assert.ok(segment[2].startsWith("base."), "Invalid AOF base designation");
      base += 1;
    } else {
      assert.equal(match[3], "i", "Unsupported AOF type");
      assert.equal(segment[2], "incr.aof", "Invalid incremental designation");
      incr += 1;
    }
  }
  assert.equal(base, 1, "Exactly one AOF base required");
  assert.ok(incr >= 1, "Incremental AOF segment required");
  assert.ok(segments.size + 1 <= MAX_FILES, "Too many AOF files");
  assert.deepEqual(
    await filesOnly(part),
    [...segments, "appendonly.aof.manifest"].sort(),
    "AOF archive is missing a file or contains an unlisted file",
  );
  const paths = [MANIFEST, ...[...segments].sort().map((name) => "appendonlydir/" + name)];
  const files = [];
  let totalBytes = 0;
  for (const name of paths) {
    const file = join(root, name);
    const stat = await ordinary(file);
    const data = await readFile(file);
    assert.equal(data.length, stat.size, "AOF changed during read");
    totalBytes += data.length;
    assert.ok(totalBytes <= MAX_BYTES, "Total AOF exceeds CI bound");
    files.push({
      path: name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  return { schemaVersion: 1, files };
}

export async function createCiAofInventory(root, destination) {
  ciOnly();
  assert.ok(resolve(destination).startsWith("/tmp/"), "CI temp inventory only");
  const value = await inspectCiAofArchive(root);
  await writeFile(destination, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return value;
}

export async function verifyCiAofInventory(root, destination) {
  ciOnly();
  const stat = await ordinary(destination);
  assert.ok(stat.size < 4096, "Inventory too large");
  const original = JSON.parse(await readFile(destination, "utf8"));
  assert.deepEqual(
    original,
    await inspectCiAofArchive(root),
    "AOF manifest/files/checksums differ from original stopped-source inventory",
  );
  return original;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, inventory] = process.argv.slice(2);
  if (!["create", "verify"].includes(mode) || !root || !inventory) {
    throw new Error("REFUSED: specify create|verify and disposable temp paths");
  }
  if (mode === "create") await createCiAofInventory(root, inventory);
  else await verifyCiAofInventory(root, inventory);
  console.log("PASS: strict local Redis multipart AOF archive integrity preflight");
}
