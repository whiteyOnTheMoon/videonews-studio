#!/usr/bin/env node
// Root-only, one-shot transfer of an EXISTING signed source export into an
// isolated staging directory. Never reads a private key or starts services.
import {
  chownSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = "/home/ap/www/videonews-studio";
const BASE = "/var/lib/videonews-studio/p2-signed-source";
const APPROVAL = "STAGE_ONE_EXISTING_SIGNED_SOURCE_EXPORT_ONLY";
const REFUSED = "REFUSED: signed source staging unsafe; do not retry installation";
const USER = { publisher: 10001, worker: 10002, transfer: 10003 };
const DEFAULT = { root: ROOT, parent: "/var/lib/videonews-studio", base: BASE, user: USER };
const must = (ok) => {
  if (!ok) throw Error(REFUSED);
};
const paths = (c) => ({
  publisher: c.base + "/publisher",
  source: c.base + "/publisher/source-export.signed.json",
  trust: c.base + "/trust-material",
  pub: c.base + "/trust-material/signing-public.pem",
  inbox: c.base + "/worker-inbox",
  checkpoint: c.base + "/worker-checkpoint",
  stage: c.base + "/handoff-staging",
  output: c.base + "/handoff-staging/source-export.signed.json",
});
function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
}
function directory(path, uid, gid, mode) {
  const st = lstatSync(path);
  must(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      st.uid === uid &&
      st.gid === gid &&
      (st.mode & 0o777) === mode &&
      realpathSync(path) === path,
  );
}
function secureRead(path, uid, gid, mode, cap) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd);
    must(
      a.isFile() &&
        a.nlink === 1 &&
        a.uid === uid &&
        a.gid === gid &&
        (a.mode & 0o777) === mode &&
        a.size > 0 &&
        a.size <= cap &&
        realpathSync(path) === path,
    );
    const data = readFileSync(fd);
    const b = fstatSync(fd);
    must(
      data.length === a.size &&
        a.ino === b.ino &&
        a.dev === b.dev &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs,
    );
    return data;
  } finally {
    closeSync(fd);
  }
}
function exact(o, fields) {
  return (
    o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    Object.keys(o).length === fields.length &&
    fields.every((k) => Object.hasOwn(o, k))
  );
}
export function inspectSource(c = DEFAULT) {
  const p = paths(c);
  directory(c.parent, 0, 0, 0o700);
  directory(c.base, 0, 0, 0o700);
  directory(p.publisher, c.user.publisher, c.user.publisher, 0o700);
  directory(p.trust, 0, 0, 0o700);
  directory(p.inbox, c.user.worker, c.user.worker, 0o700);
  directory(p.checkpoint, c.user.worker, c.user.worker, 0o700);
  const key = createPublicKey(secureRead(p.pub, 0, c.user.worker, 0o440, 8192));
  must(key.type === "public" && key.asymmetricKeyType === "ed25519");
  const data = secureRead(p.source, c.user.publisher, c.user.publisher, 0o600, 49152);
  const doc = JSON.parse(data.toString("utf8"));
  must(
    exact(doc, ["format", "export", "signature"]) &&
      doc.format === "vns-source-export-ed25519-v1" &&
      typeof doc.signature === "string" &&
      /^[A-Za-z0-9_-]{86}$/.test(doc.signature),
  );
  const sig = Buffer.from(doc.signature, "base64url");
  must(
    sig.length === 64 &&
      sig.toString("base64url") === doc.signature &&
      verifySignature(
        null,
        Buffer.from("VNS source export signature v1\0" + JSON.stringify(doc.export)),
        key,
        sig,
      ),
  );
  const b = doc.export;
  must(
    exact(b, [
      "version",
      "sourceRevision",
      "hostApprovalRevision",
      "allowedHosts",
      "registryJson",
      "sha256",
    ]),
  );
  must(
    b.version === 1 &&
      Number.isSafeInteger(b.sourceRevision) &&
      b.sourceRevision > 0 &&
      Number.isSafeInteger(b.hostApprovalRevision) &&
      b.hostApprovalRevision > 0 &&
      Array.isArray(b.allowedHosts) &&
      b.allowedHosts.length > 0 &&
      b.allowedHosts.length <= 5 &&
      b.allowedHosts.every((h) => typeof h === "string") &&
      typeof b.registryJson === "string" &&
      typeof b.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(b.sha256),
  );
  const body = {
    version: b.version,
    sourceRevision: b.sourceRevision,
    hostApprovalRevision: b.hostApprovalRevision,
    allowedHosts: b.allowedHosts,
    registryJson: b.registryJson,
  };
  must(createHash("sha256").update(JSON.stringify(body)).digest("hex") === b.sha256);
  must(Buffer.byteLength(JSON.stringify(doc)) === data.length);
  return data;
}
export function verifyStage(c = DEFAULT) {
  const p = paths(c);
  const data = inspectSource(c);
  directory(p.stage, c.user.transfer, c.user.worker, 0o750);
  must(readdirSync(p.stage).join("\n") === "source-export.signed.json");
  const output = secureRead(p.output, c.user.transfer, c.user.worker, 0o640, 49152);
  must(data.equals(output));
}
export function preflight(c = DEFAULT) {
  const p = paths(c);
  inspectSource(c);
  must(absent(p.stage));
  must(readdirSync(p.inbox).length === 0 && readdirSync(p.checkpoint).length === 0);
}
export function stageOnce(c = DEFAULT) {
  const p = paths(c);
  const data = inspectSource(c);
  must(absent(p.stage));
  must(readdirSync(p.inbox).length === 0 && readdirSync(p.checkpoint).length === 0);
  // Stage starts root-private: the transfer UID cannot race the write.
  mkdirSync(p.stage, { mode: 0o700 });
  const fd = openSync(
    p.output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < data.length) {
      const count = writeSync(fd, data, written, data.length - written);
      must(count > 0);
      written += count;
    }
    fchownSync(fd, c.user.transfer, c.user.worker);
    fchmodSync(fd, 0o640);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const stageFd = openSync(
    p.stage,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(stageFd);
  } finally {
    closeSync(stageFd);
  }
  // Ownership is delegated only after all bytes and metadata are durable.
  chownSync(p.stage, c.user.transfer, c.user.worker);
  chmodSync(p.stage, 0o750);
  const baseFd = openSync(
    c.base,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(baseFd);
  } finally {
    closeSync(baseFd);
  }
  verifyStage(c);
}
function command(args) {
  return execFileSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function release(sha) {
  must(process.getuid?.() === 0 && /^[a-f0-9]{40}$/.test(sha));
  const git = (...args) => command(["git", "-c", "safe.directory=" + ROOT, "-C", ROOT, ...args]);
  must(git("branch", "--show-current") === "main");
  must(git("rev-parse", "HEAD") === sha);
  must(git("status", "--porcelain") === "");
  const services = command([
    "docker",
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=videonews-studio",
    "--format",
    '{{.Label "com.docker.compose.service"}}',
  ]).split("\n");
  const blocked = new Set([
    "source-publisher",
    "source-handoff-import",
    "feed-observer",
    "feed-scheduler",
    "feed-producer",
    "feed-producer-continuous",
    "feed-consumer",
    "feed-project-once",
    "feed-project-continuous",
  ]);
  must(!services.some((service) => blocked.has(service)));
}
function main(argv) {
  must(argv.length >= 3 && argv.length <= 5);
  const [action, flag, sha, ...rest] = argv;
  must(["--preflight", "--install", "--verify"].includes(action));
  must(flag === "--expected-sha");
  if (action === "--install") must(rest.join(" ") === "--approval " + APPROVAL);
  else must(rest.length === 0);
  release(sha);
  if (action === "--preflight") preflight();
  if (action === "--install") stageOnce();
  if (action === "--verify") verifyStage();
  console.log(
    action === "--preflight"
      ? "PASS: existing signed export ready for one-shot staging"
      : action === "--install"
        ? "PASS: one signed source export staged without starting services"
        : "PASS: staged source matches signed publisher export byte-for-byte",
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error(REFUSED);
    process.exitCode = 2;
  }
}
