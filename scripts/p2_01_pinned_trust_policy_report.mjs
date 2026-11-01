#!/usr/bin/env node
// Read-only operator report for the independently pinned Ed25519 key policy.
// Never reads a private key, opens the anchor DB, changes a file or starts Docker.
import { createHash, createPublicKey } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "/home/ap/www/videonews-studio";
const KEY = "/var/lib/videonews-studio/p2-signed-source/trust-material/signing-public.pem";
const REFUSED = "REFUSED: trusted source policy report unavailable";
const must = (ok) => {
  if (!ok) throw Error(REFUSED);
};

export function parseTrustRevision(value) {
  must(typeof value === "string" && /^[1-9][0-9]{0,14}$/.test(value));
  const n = Number(value);
  must(Number.isSafeInteger(n));
  return n;
}
function strictDirectory(path, uid = 0, gid = 0, mode = 0o700) {
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
export function readPinnedPublicKey(path = KEY, uid = 0, gid = 10002, mode = 0o440) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    must(
      st.isFile() &&
        st.nlink === 1 &&
        st.uid === uid &&
        st.gid === gid &&
        (st.mode & 0o777) === mode &&
        st.size >= 16 &&
        st.size <= 8192,
    );
    const pem = readFileSync(fd);
    const key = createPublicKey(pem);
    must(key.type === "public" && key.asymmetricKeyType === "ed25519");
    return key;
  } finally {
    closeSync(fd);
  }
}
/** Byte-for-byte compatible with pinnedTrustPolicyDigest in @vns/worker. */
export function calculateTrustPolicyManifest(key, policyRevision) {
  must(Number.isSafeInteger(policyRevision) && policyRevision > 0);
  must(key.type === "public" && key.asymmetricKeyType === "ed25519");
  const publicKeyFingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  const epoch = [publicKeyFingerprint, 1, 1, null, null];
  const policySha256 = createHash("sha256")
    .update(JSON.stringify(["vns-source-trust-policy-v1", policyRevision, [epoch]]))
    .digest("hex");
  return Object.freeze({
    policyRevision,
    publicKeyFingerprint,
    policySha256,
    sourceEpochStart: 1,
    hostEpochStart: 1,
  });
}
function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function release(sha) {
  must(process.getuid?.() === 0 && /^[a-f0-9]{40}$/.test(sha));
  const git = (...args) => run("git", ["-c", "safe.directory=" + ROOT, "-C", ROOT, ...args]);
  must(git("branch", "--show-current") === "main");
  must(git("rev-parse", "HEAD") === sha);
  must(git("status", "--porcelain") === "");
}
function report(args) {
  must(
    args.length === 5 &&
      args[0] === "--report" &&
      args[1] === "--expected-sha" &&
      args[3] === "--policy-revision",
  );
  release(args[2]);
  const revision = parseTrustRevision(args[4]);
  strictDirectory("/var/lib/videonews-studio");
  strictDirectory("/var/lib/videonews-studio/p2-signed-source");
  strictDirectory("/var/lib/videonews-studio/p2-signed-source/trust-material");
  const key = readPinnedPublicKey();
  console.log(
    JSON.stringify({
      status: "local_fingerprint_only",
      independent_anchor_verified: false,
      ...calculateTrustPolicyManifest(key, revision),
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    report(process.argv.slice(2));
  } catch {
    console.error(REFUSED);
    process.exitCode = 2;
  }
}
