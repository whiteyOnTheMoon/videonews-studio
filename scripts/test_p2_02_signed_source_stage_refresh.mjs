import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageOnce } from "./p2_01_signed_handoff_stage.mjs";
import {
  preflightRefresh, atomicRefreshStage, verifyRefreshedStage,
} from "./p2_02_signed_source_stage_refresh.mjs";

const ROOT_ONLY = process.getuid?.() === 0;
const HOSTS = ["www.nasa.gov", "www.noaa.gov", "www.usgs.gov"];
const OLD_URL = "https://www.usgs.gov/news/national-news-release/feed";
const NEW_URL = "https://www.usgs.gov/news/149248/feed";

function source(id, host, basePath, feedPath) {
  return {
    id,
    baseUrl: "https://" + host + basePath,
    feedUrl: "https://" + host + feedPath,
    status: "approved",
    access: "rss",
    intervalMinutes: 60,
    termsUrl: "https://" + host + "/",
    usage: "metadata_only",
    licenseNotes: "Only approved metadata from a personally reviewed publisher.",
    reviewedAt: "2026-11-03",
  };
}
function sources(usgsFeed) {
  return [
    source("nasa_news", "www.nasa.gov", "/news/", "/news-release/feed/"),
    source("noaa_news", "www.noaa.gov", "/", "/rss.xml"),
    { ...source("usgs_news", "www.usgs.gov", "/news/", usgsFeed.replace("https://www.usgs.gov", "")) },
  ];
}
function sealed(key, sourceRevision, feedUrl, edit) {
  const entries = sources(feedUrl);
  if (sourceRevision === 10) entries[2].reviewedAt = "2026-11-04";
  if (edit) edit(entries);
  const body = {
    version: 1,
    sourceRevision,
    hostApprovalRevision: 7,
    allowedHosts: HOSTS,
    registryJson: JSON.stringify({ version: 1, sources: entries }),
  };
  const bundle = {
    ...body,
    sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  return Buffer.from(JSON.stringify({
    format: "vns-source-export-ed25519-v1",
    export: bundle,
    signature: sign(null,
      Buffer.from("VNS source export signature v1\0" + JSON.stringify(bundle)),
      key).toString("base64url"),
  }));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vns-usgs-stage-refresh-"));
  const parent = join(root, "videonews-studio");
  const base = join(parent, "p2-signed-source");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(base, { mode: 0o700 });
  const path = (relative) => join(base, relative);
  for (const [name, uid, gid] of [
    ["publisher", 10001, 10001],
    ["trust-material", 0, 0],
    ["worker-inbox", 10002, 10002],
    ["worker-checkpoint", 10002, 10002],
  ]) {
    mkdirSync(path(name), { mode: 0o700 });
    chownSync(path(name), uid, gid);
  }
  const keys = generateKeyPairSync("ed25519");
  const prior = sealed(keys.privateKey, 8, OLD_URL);
  const current = sealed(keys.privateKey, 10, NEW_URL);
  writeFileSync(path("publisher/source-export.signed.json"), prior, { mode: 0o600 });
  chownSync(path("publisher/source-export.signed.json"), 10001, 10001);
  writeFileSync(path("trust-material/signing-public.pem"),
    keys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o440 });
  chownSync(path("trust-material/signing-public.pem"), 0, 10002);
  chmodSync(path("trust-material/signing-public.pem"), 0o440);
  const config = { parent, base, user: { publisher: 10001, worker: 10002, transfer: 10003 } };
  stageOnce(config);
  writeFileSync(path("worker-inbox/source-export.signed.json"), prior, { mode: 0o600 });
  chownSync(path("worker-inbox/source-export.signed.json"), 10002, 10002);
  const checkpoint = Buffer.from(JSON.stringify({
    version: 1,
    sourceRevision: 8,
    hostApprovalRevision: 7,
    envelopeSha256: createHash("sha256").update(prior).digest("hex"),
  }));
  writeFileSync(path("worker-checkpoint/source-export.checkpoint.json"), checkpoint, { mode: 0o600 });
  chownSync(path("worker-checkpoint/source-export.checkpoint.json"), 10002, 10002);
  writeFileSync(path("publisher/source-export.signed.json"), current);
  return {
    root, config, path, prior, current, checkpoint, keys,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
test("atomic refresh accepts only valid 8/7 -> 10/7 and preserves worker state", {
  skip: !ROOT_ONLY,
}, () => {
  const f = fixture();
  try {
    preflightRefresh(f.config);
    atomicRefreshStage(f.config);
    verifyRefreshedStage(f.config);
    assert.deepEqual(readFileSync(f.path("handoff-staging/source-export.signed.json")), f.current);
    assert.deepEqual(readFileSync(f.path("worker-inbox/source-export.signed.json")), f.prior);
    assert.deepEqual(readFileSync(f.path("worker-checkpoint/source-export.checkpoint.json")), f.checkpoint);
    assert.equal(statSync(f.path("handoff-staging/source-export.signed.json")).uid, 10003);
    assert.equal(statSync(f.path("handoff-staging/source-export.signed.json")).gid, 10002);
    assert.equal(statSync(f.path("handoff-staging/source-export.signed.json")).mode & 0o777, 0o640);
    assert.deepEqual(
      requireDirectoryContents(f.path("handoff-staging")), ["source-export.signed.json"],
    );
    assert.throws(() => atomicRefreshStage(f.config));
  } finally { f.cleanup(); }
});
function requireDirectoryContents(dir) {
  // Import lazily to ensure only root-specific tests access their fixture.
  return readdirSync(dir).sort();
}
test("changed checkpoint or inbox refuses refresh without changing old stage", {
  skip: !ROOT_ONLY,
}, () => {
  for (const target of ["checkpoint", "inbox"]) {
    const f = fixture();
    try {
      if (target === "checkpoint") {
        const file = f.path("worker-checkpoint/source-export.checkpoint.json");
        const value = JSON.parse(f.checkpoint.toString());
        value.envelopeSha256 = "a".repeat(64);
        writeFileSync(file, JSON.stringify(value));
      } else {
        writeFileSync(f.path("worker-inbox/source-export.signed.json"), "corrupted");
      }
      assert.throws(() => preflightRefresh(f.config));
      assert.throws(() => atomicRefreshStage(f.config));
      assert.deepEqual(readFileSync(f.path("handoff-staging/source-export.signed.json")), f.prior);
    } finally { f.cleanup(); }
  }
});
test("wrong signer and unrelated NASA changes refuse refresh", { skip: !ROOT_ONLY }, () => {
  const f = fixture();
  try {
    const different = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(f.path("publisher/source-export.signed.json"), sealed(different, 10, NEW_URL));
    assert.throws(() => preflightRefresh(f.config));
    assert.deepEqual(readFileSync(f.path("handoff-staging/source-export.signed.json")), f.prior);
    writeFileSync(f.path("publisher/source-export.signed.json"), sealed(f.keys.privateKey, 10, NEW_URL, (entries) => {
      entries[0].intervalMinutes = 120;
    }));
    assert.throws(() => preflightRefresh(f.config));
    assert.deepEqual(readFileSync(f.path("handoff-staging/source-export.signed.json")), f.prior);
  } finally { f.cleanup(); }
});
test("wrong URL, old revision or host revision refuse refresh", { skip: !ROOT_ONLY }, () => {
  const f = fixture();
  try {
    for (const value of [
      sealed(f.keys.privateKey, 9, NEW_URL),
      sealed(f.keys.privateKey, 10, OLD_URL),
      sealed(f.keys.privateKey, 10, NEW_URL, (entries) => { entries[2].licenseNotes = "Altered metadata rights"; }),
    ]) {
      writeFileSync(f.path("publisher/source-export.signed.json"), value);
      assert.throws(() => preflightRefresh(f.config));
      assert.deepEqual(readFileSync(f.path("handoff-staging/source-export.signed.json")), f.prior);
    }
  } finally { f.cleanup(); }
});
test("CLI refuses unpinned/unapproved attempts without touching project paths", () => {
  const script = fileURLToPath(new URL("./p2_02_signed_source_stage_refresh.mjs", import.meta.url));
  for (const args of [
    ["--preflight", "--expected-sha", "0".repeat(40)],
    ["--install", "--expected-sha", "0".repeat(40)],
    ["--install", "--expected-sha", "0".repeat(40), "--approval", "WRONG"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: signed source stage refresh unsafe/);
    assert.doesNotMatch(result.stdout, /PASS:/);
  }
});
