#!/usr/bin/env node
// Operator-only UPDATE of an existing signed handoff stage; never re-bootstrap.
// This does not sign, import, update the SQL anchor, or start feed workers.
import {
  chmodSync, chownSync, closeSync, constants, fchmodSync, fchownSync,
  fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSource, verifyStage } from "./p2_01_signed_handoff_stage.mjs";

const ROOT = "/home/ap/www/videonews-studio";
const BASE = "/var/lib/videonews-studio/p2-signed-source";
const REFUSED = "REFUSED: signed source stage refresh unsafe; inspect state, do not retry";
const APPROVAL = "REFRESH_VERIFIED_USGS_STAGE_8_TO_10_ONLY";
const OLD = 8;
const NEW = 10;
const HOST = 7;
const OLD_USGS = "https://www.usgs.gov/news/national-news-release/feed";
const NEW_USGS = "https://www.usgs.gov/news/149248/feed";
const APPROVED_HOSTS = ["www.nasa.gov", "www.noaa.gov", "www.usgs.gov"];
const IDS = ["nasa_news", "noaa_news", "usgs_news"];
const MAX_FILE = 49152;
const UIDS = Object.freeze({ publisher: 10001, worker: 10002, transfer: 10003 });
const must = (ok) => { if (!ok) throw Error(REFUSED); };
const config = { root: ROOT, parent: "/var/lib/videonews-studio", base: BASE, user: UIDS };

function paths(c) {
  return {
    stage: join(c.base, "handoff-staging"),
    staged: join(c.base, "handoff-staging/source-export.signed.json"),
    inbox: join(c.base, "worker-inbox"),
    imported: join(c.base, "worker-inbox/source-export.signed.json"),
    checkpoint: join(c.base, "worker-checkpoint"),
    checkpointFile: join(c.base, "worker-checkpoint/source-export.checkpoint.json"),
    publicKey: join(c.base, "trust-material/signing-public.pem"),
  };
}
function directory(path, uid, gid, mode) {
  const info = lstatSync(path);
  must(info.isDirectory() && !info.isSymbolicLink() &&
    info.uid === uid && info.gid === gid && (info.mode & 0o777) === mode &&
    realpathSync(path) === path);
}
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}
function protectedBytes(path, uid, gid, mode, max = MAX_FILE) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd);
    must(first.isFile() && first.nlink === 1 && first.uid === uid && first.gid === gid &&
      (first.mode & 0o777) === mode && first.size > 1 && first.size <= max &&
      realpathSync(path) === path);
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    must(data.length === first.size && after.dev === first.dev && after.ino === first.ino &&
      after.mtimeMs === first.mtimeMs && after.ctimeMs === first.ctimeMs);
    return data;
  } finally {
    closeSync(fd);
  }
}
function digest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}
function verifiedEnvelope(bytes, key) {
  must(bytes.length > 1 && bytes.length <= MAX_FILE);
  const value = JSON.parse(bytes.toString("utf8"));
  must(exact(value, ["format", "export", "signature"]) &&
    value.format === "vns-source-export-ed25519-v1" &&
    typeof value.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(value.signature));
  const bundle = value.export;
  must(exact(bundle, [
    "version", "sourceRevision", "hostApprovalRevision", "allowedHosts", "registryJson", "sha256",
  ]) && bundle.version === 1 &&
    Number.isSafeInteger(bundle.sourceRevision) && bundle.sourceRevision > 0 &&
    Number.isSafeInteger(bundle.hostApprovalRevision) && bundle.hostApprovalRevision > 0 &&
    Array.isArray(bundle.allowedHosts) &&
    bundle.allowedHosts.length === APPROVED_HOSTS.length &&
    bundle.allowedHosts.every((host, index) => host === APPROVED_HOSTS[index]) &&
    typeof bundle.registryJson === "string" &&
    typeof bundle.sha256 === "string" && /^[a-f0-9]{64}$/.test(bundle.sha256));
  const bare = {
    version: bundle.version,
    sourceRevision: bundle.sourceRevision,
    hostApprovalRevision: bundle.hostApprovalRevision,
    allowedHosts: bundle.allowedHosts,
    registryJson: bundle.registryJson,
  };
  must(digest(JSON.stringify(bare)) === bundle.sha256);
  must(Buffer.from(JSON.stringify(value)).equals(bytes));
  const sig = Buffer.from(value.signature, "base64url");
  must(sig.length === 64 && sig.toString("base64url") === value.signature &&
    verifySignature(null,
      Buffer.from("VNS source export signature v1\0" + JSON.stringify(bundle), "utf8"),
      key, sig));
  return bundle;
}
function stable(value) {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
function registry(bundle) {
  const raw = JSON.parse(bundle.registryJson);
  must(exact(raw, ["version", "sources"]) && raw.version === 1 &&
    Array.isArray(raw.sources) && raw.sources.length === 3);
  const entries = new Map();
  for (const entry of raw.sources) {
    must(entry && typeof entry === "object" && !Array.isArray(entry) &&
      typeof entry.id === "string" && !entries.has(entry.id) &&
      entry.status === "approved" && entry.usage === "metadata_only");
    entries.set(entry.id, entry);
  }
  must(IDS.every((id) => entries.has(id)) && entries.size === IDS.length);
  return entries;
}
function safeEvolution(prior, current) {
  must(prior.sourceRevision === OLD && current.sourceRevision === NEW &&
    prior.hostApprovalRevision === HOST && current.hostApprovalRevision === HOST);
  const oldEntries = registry(prior);
  const newEntries = registry(current);
  for (const id of IDS) {
    const before = oldEntries.get(id);
    const after = newEntries.get(id);
    if (id !== "usgs_news") {
      must(stable(before) === stable(after));
    } else {
      must(before.baseUrl === "https://www.usgs.gov/news/" &&
        after.baseUrl === before.baseUrl &&
        before.feedUrl === OLD_USGS && after.feedUrl === NEW_USGS);
      const dropReviewFields = (item) => {
        const { feedUrl, reviewedAt, ...unchanged } = item;
        return unchanged;
      };
      must(stable(dropReviewFields(before)) === stable(dropReviewFields(after)) &&
        typeof after.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(after.reviewedAt));
    }
  }
}
function checkpoint(bytes) {
  const data = JSON.parse(bytes.toString("utf8"));
  must(exact(data, ["version", "sourceRevision", "hostApprovalRevision", "envelopeSha256"]) &&
    data.version === 1 && data.sourceRevision === OLD &&
    data.hostApprovalRevision === HOST &&
    typeof data.envelopeSha256 === "string" && /^[a-f0-9]{64}$/.test(data.envelopeSha256));
  return data;
}
export function preflightRefresh(c = config) {
  const p = paths(c);
  const publisherBytes = inspectSource(c); // independently pinned public key and signature
  directory(p.stage, c.user.transfer, c.user.worker, 0o750);
  directory(p.inbox, c.user.worker, c.user.worker, 0o700);
  directory(p.checkpoint, c.user.worker, c.user.worker, 0o700);
  must(readdirSync(p.stage).length === 1 && readdirSync(p.stage)[0] === "source-export.signed.json");
  const key = createPublicKey(protectedBytes(p.publicKey, 0, c.user.worker, 0o440, 8192));
  must(key.type === "public" && key.asymmetricKeyType === "ed25519");
  const oldBytes = protectedBytes(p.staged, c.user.transfer, c.user.worker, 0o640);
  const imported = protectedBytes(p.imported, c.user.worker, c.user.worker, 0o600);
  const cpBytes = protectedBytes(p.checkpointFile, c.user.worker, c.user.worker, 0o600);
  must(oldBytes.equals(imported));
  const old = verifiedEnvelope(oldBytes, key);
  const next = verifiedEnvelope(publisherBytes, key);
  const cp = checkpoint(cpBytes);
  must(cp.envelopeSha256 === digest(oldBytes));
  safeEvolution(old, next);
  return { publisherBytes, oldBytes, cpBytes };
}
export function refreshStage(c = config) {
  const p = paths(c);
  const state = preflightRefresh(c);
  const basename = ".source-export.signed." + randomBytes(12).toString("hex") + ".tmp";
  const temporary = join(p.stage, basename);
  let created = false;
  try {
    const fd = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      let written = 0;
      while (written < state.publisherBytes.length) {
        const n = writeSync(fd, state.publisherBytes, written, state.publisherBytes.length - written);
        must(n > 0);
        written += n;
      }
      fchownSync(fd, c.user.transfer, c.user.worker);
      fchmodSync(fd, 0o640);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    must(protectedBytes(temporary, c.user.transfer, c.user.worker, 0o640)
      .equals(state.publisherBytes));
    // Verify no unrelated service or publisher changed between preflight and rename.
    const second = preflightRefresh(c);
    must(second.publisherBytes.equals(state.publisherBytes) &&
      second.oldBytes.equals(state.oldBytes) && second.cpBytes.equals(state.cpBytes));
    // preflightRefresh forbids extra staging entries. The temporary file is deliberately
    // removed from the listing check by using a separate targeted revalidation below.
  } finally {
    if (created) unlinkSync(temporary);
  }
}
function atomicRefreshStage(c = config) {
  const p = paths(c);
  const state = preflightRefresh(c);
  const temp = join(p.stage, ".source-export.signed." + randomBytes(12).toString("hex") + ".tmp");
  let present = false;
  try {
    const fd = openSync(temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    present = true;
    try {
      let n = 0;
      while (n < state.publisherBytes.length) {
        const written = writeSync(fd, state.publisherBytes, n, state.publisherBytes.length - n);
        must(written > 0);
        n += written;
      }
      fchownSync(fd, c.user.transfer, c.user.worker);
      fchmodSync(fd, 0o640);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    must(protectedBytes(temp, c.user.transfer, c.user.worker, 0o640).equals(state.publisherBytes));
    // A second check deliberately excludes the temp name, which only root may create.
    must(readdirSync(p.stage).sort().join("\n") ===
      [".source-export.signed." + temp.split(".signed.")[1], "source-export.signed.json"].sort().join("\n"));
    must(inspectSource(c).equals(state.publisherBytes));
    must(protectedBytes(p.staged, c.user.transfer, c.user.worker, 0o640).equals(state.oldBytes));
    must(protectedBytes(p.imported, c.user.worker, c.user.worker, 0o600).equals(state.oldBytes));
    must(protectedBytes(p.checkpointFile, c.user.worker, c.user.worker, 0o600).equals(state.cpBytes));
    renameSync(temp, p.staged);
    present = false;
    const dfd = openSync(p.stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
    verifyStage(c);
    must(protectedBytes(p.imported, c.user.worker, c.user.worker, 0o600).equals(state.oldBytes));
    must(protectedBytes(p.checkpointFile, c.user.worker, c.user.worker, 0o600).equals(state.cpBytes));
  } finally {
    if (present) unlinkSync(temp);
  }
}
export function verifyRefreshedStage(c = config) {
  verifyStage(c);
  const p = paths(c);
  const key = createPublicKey(protectedBytes(p.publicKey, 0, c.user.worker, 0o440, 8192));
  const body = verifiedEnvelope(inspectSource(c), key);
  must(body.sourceRevision === NEW && body.hostApprovalRevision === HOST);
}
function cmd(args) {
  return execFileSync(args[0], args.slice(1), {
    encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function release(sha) {
  must(process.getuid?.() === 0 && /^[a-f0-9]{40}$/.test(sha));
  const git = (...args) => cmd(["git", "-c", "safe.directory=" + ROOT, "-C", ROOT, ...args]);
  must(git("branch", "--show-current") === "main" &&
    git("rev-parse", "HEAD") === sha && git("status", "--porcelain") === "");
  const services = cmd(["docker", "ps", "-a",
    "--filter", "label=com.docker.compose.project=videonews-studio",
    "--format", '{{.Label "com.docker.compose.service"}}']).split("\n");
  const blocked = new Set([
    "source-publisher", "source-handoff-import", "feed-observer",
    "feed-scheduler", "feed-producer", "feed-producer-continuous",
    "feed-consumer", "feed-project-once", "feed-project-continuous",
  ]);
  must(!services.some((service) => blocked.has(service)));
}
function main(argv) {
  must(argv.length === 3 || argv.length === 5);
  const [action, flag, sha, ...rest] = argv;
  must(["--preflight", "--install", "--verify"].includes(action) &&
    flag === "--expected-sha");
  if (action === "--install") {
    must(rest.length === 2 && rest[0] === "--approval" && rest[1] === APPROVAL);
  } else {
    must(rest.length === 0);
  }
  release(sha);
  if (action === "--preflight") {
    preflightRefresh();
    console.log("PASS: verified publisher 10/7, old stage/inbox/checkpoint 8/7; no changes");
  } else if (action === "--install") {
    atomicRefreshStage();
    console.log("PASS: stage 10/7 atomically refreshed; inbox/checkpoint remain 8/7");
  } else {
    verifyRefreshedStage();
    console.log("PASS: stage matches independently signed publisher export 10/7");
  }
  console.log("INFO: no private key reads, database writes, queue changes or feed jobs");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); }
  catch { console.error(REFUSED); process.exitCode = 2; }
}
