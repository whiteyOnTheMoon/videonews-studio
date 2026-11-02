#!/usr/bin/env node
// Read-only candidate for an independently administered source/trust anchor.
// A local hash is NOT an external approval, a remote connection or a bootstrap.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSource, verifyStage } from "./p2_01_signed_handoff_stage.mjs";
import {
  calculateTrustPolicyManifest,
  parseTrustRevision,
  readPinnedPublicKey,
} from "./p2_01_pinned_trust_policy_report.mjs";

const ROOT = "/home/ap/www/videonews-studio";
const BASE = "/var/lib/videonews-studio/p2-signed-source";
const CONFIG = {
  parent: "/var/lib/videonews-studio",
  base: BASE,
  user: { publisher: 10001, worker: 10002, transfer: 10003 },
};
const REFUSED = "REFUSED: independent anchor candidate evidence unavailable";
const FILE = "source-export.signed.json";
const CHECKPOINT = "source-export.checkpoint.json";
const must = (condition) => {
  if (!condition) throw Error(REFUSED);
};

function strictWorkerFile(path, uid, gid) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    must(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === uid &&
        before.gid === gid &&
        (before.mode & 0o777) === 0o600 &&
        before.size >= 2 &&
        before.size <= 49152 &&
        realpathSync(path) === path,
    );
    const data = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    must(
      data.length === before.size &&
        after.ino === before.ino &&
        after.dev === before.dev &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
    );
    return data;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Build a first-bootstrap CANDIDATE, not an approval. The signed publisher
 * output, group-read-only transfer stage and private worker inbox must be
 * identical canonical bytes. A checkpoint or leftover lock refuses the
 * first-bootstrap report: never imply an existing anchor can be reset.
 *
 * This matches source-export-files.ts hash(JSON.stringify(signedEnvelope)).
 */
export function buildAnchorBootstrapCandidate(config = CONFIG, policyRevision = 1) {
  must(Number.isSafeInteger(policyRevision) && policyRevision > 0);
  verifyStage(config);
  const publisher = inspectSource(config);
  const parsed = JSON.parse(publisher.toString("utf8"));
  must(Buffer.from(JSON.stringify(parsed), "utf8").equals(publisher));
  const inbox = config.base + "/worker-inbox";
  const checkpoint = config.base + "/worker-checkpoint";
  must(readdirSync(inbox).join("\n") === FILE);
  must(readdirSync(checkpoint).length === 0);
  const received = strictWorkerFile(inbox + "/" + FILE, config.user.worker, config.user.worker);
  must(received.equals(publisher));
  const key = readPinnedPublicKey(
    config.base + "/trust-material/signing-public.pem",
    0,
    config.user.worker,
    0o440,
  );
  const policy = calculateTrustPolicyManifest(key, policyRevision);
  return Object.freeze({
    schemaVersion: 1,
    status: "bootstrap_candidate_only",
    externalAnchorVerified: false,
    independentlyApproved: false,
    checkpointCreated: false,
    sourceRevision: parsed.export.sourceRevision,
    hostApprovalRevision: parsed.export.hostApprovalRevision,
    envelopeSha256: createHash("sha256").update(received).digest("hex"),
    policyRevision: policy.policyRevision,
    publicKeyFingerprint: policy.publicKeyFingerprint,
    policySha256: policy.policySha256,
    sourceEpochStart: policy.sourceEpochStart,
    hostEpochStart: policy.hostEpochStart,
  });
}

function command(name, args) {
  return execFileSync(name, args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyRelease(expectedSha) {
  must(process.getuid?.() === 0 && /^[a-f0-9]{40}$/.test(expectedSha));
  const git = (...args) => command("git", ["-c", "safe.directory=" + ROOT, "-C", ROOT, ...args]);
  must(git("branch", "--show-current") === "main");
  must(git("rev-parse", "HEAD") === expectedSha);
  must(git("status", "--porcelain") === "");
}

function main(args) {
  must(
    args.length === 5 &&
      args[0] === "--report" &&
      args[1] === "--expected-sha" &&
      args[3] === "--policy-revision",
  );
  verifyRelease(args[2]);
  const revision = parseTrustRevision(args[4]);
  console.log(JSON.stringify(buildAnchorBootstrapCandidate(CONFIG, revision)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error(REFUSED);
    process.exitCode = 2;
  }
}
