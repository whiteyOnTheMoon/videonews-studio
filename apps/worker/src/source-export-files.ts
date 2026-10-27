import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  publisherPublicKey,
  sealDormantSourceExport,
  verifyDormantSourceSignature,
  type SignedDormantSourceExport,
} from "./source-export-signature.js";
import type { DormantSourceExport } from "./source-registry-export.js";
import type { RegisteredResearchSource } from "./source-registry.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

const EXPORT_FILE = "source-export.signed.json";
const CHECKPOINT_FILE = "source-export.checkpoint.json";
const MAX_FILE_BYTES = 49152;
const SHA256 = /^[a-f0-9]{64}$/;

export interface SourceRevisionAnchorState {
  sourceRevision: number;
  hostApprovalRevision: number;
  envelopeSha256: string;
}

/**
 * Must be implemented by an independently protected, durable, linearizable store.
 * advance MUST atomically reject either decreasing revision or an alternative
 * envelope at an identical revision pair. A local file in the checkpoint trust
 * domain is NOT a valid implementation. Reject on any read/write uncertainty.
 */
export interface IndependentSourceRevisionAnchor {
  advance(candidate: Readonly<SourceRevisionAnchorState>): Promise<void>;
}

interface DurableCheckpoint {
  version: 1;
  sourceRevision: number;
  hostApprovalRevision: number;
  envelopeSha256: string;
}
function hash(envelope: SignedDormantSourceExport): string {
  return createHash("sha256").update(JSON.stringify(envelope), "utf8").digest("hex");
}
function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The caller must provision a private, owned, non-symlink directory.
 * An ancestor symlink or writable-by-group directory fails closed.
 */
async function checkDirectory(directory: string): Promise<void> {
  if (!directory.startsWith("/") || resolve(directory) !== directory) {
    throw new Error("Source state directory must be an absolute canonical path");
  }
  const [stat, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== directory ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Source state directory is not private");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function readPrivateJson(directory: string, name: string): Promise<unknown | null> {
  let file;
  try {
    file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return null;
    throw new Error("Private source state unavailable");
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > MAX_FILE_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("Private source state permissions or size invalid");
    }
    return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await file.close();
  }
}
async function atomicWrite(directory: string, name: string, data: object): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(data), "utf8");
  if (bytes.length < 2 || bytes.length > MAX_FILE_BYTES) {
    throw new Error("Source state write size invalid");
  }
  const temp = join(directory, "." + name + "." + randomBytes(12).toString("hex") + ".tmp");
  let created = false;
  try {
    const file = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(directory, name));
    created = false;
    await syncDirectory(directory);
  } finally {
    bytes.fill(0);
    if (created) await rm(temp, { force: true });
  }
}
async function exclusive<T>(
  directory: string,
  purpose: "publisher" | "consumer",
  operation: () => Promise<T>,
): Promise<T> {
  await checkDirectory(directory);
  const lock = join(directory, "." + purpose + ".lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error("Source state lock busy or stale; operator recovery required");
  }
  try {
    await syncDirectory(directory);
    return await operation();
  } finally {
    await rmdir(lock);
    await syncDirectory(directory);
  }
}
function checkpointFrom(raw: unknown): DurableCheckpoint {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Worker checkpoint unavailable");
  }
  const obj = raw as Record<string, unknown>;
  if (
    Object.keys(obj).length !== 4 ||
    obj.version !== 1 ||
    !safeRevision(obj.sourceRevision) ||
    !safeRevision(obj.hostApprovalRevision) ||
    typeof obj.envelopeSha256 !== "string" ||
    !SHA256.test(obj.envelopeSha256)
  ) {
    throw new Error("Worker checkpoint malformed");
  }
  return obj as unknown as DurableCheckpoint;
}

/**
 * Offline publisher: writes one signed envelope by fsync + rename + dir fsync.
 * Serializes publishers using an exclusive lock; a stale lock after power loss
 * intentionally requires operator intervention, never automatic expiration.
 */
export async function publishDormantSourceFile(
  directory: string,
  bundle: DormantSourceExport,
  trustedPolicy: ApprovedFetchPolicy,
  privateKey: KeyObject,
): Promise<void> {
  const sealed = sealDormantSourceExport(bundle, trustedPolicy, privateKey);
  await exclusive(directory, "publisher", async () => {
    const previous = await readPrivateJson(directory, EXPORT_FILE);
    if (previous !== null) {
      // Historical verification uses its OWN former hosts only to validate
      // the old signature/revisions, never to authorize a NEW network fetch.
      if (
        !previous ||
        typeof previous !== "object" ||
        !("export" in previous) ||
        !previous.export ||
        typeof previous.export !== "object" ||
        !("allowedHosts" in previous.export) ||
        !Array.isArray(previous.export.allowedHosts)
      ) {
        throw new Error("Previous published source state invalid");
      }
      const old = verifyDormantSourceSignature(
        previous,
        { enabled: true, hosts: previous.export.allowedHosts },
        publisherPublicKey(privateKey),
      ).sealed;
      if (
        bundle.sourceRevision < old.export.sourceRevision ||
        bundle.hostApprovalRevision < old.export.hostApprovalRevision ||
        (bundle.sourceRevision === old.export.sourceRevision &&
          bundle.hostApprovalRevision === old.export.hostApprovalRevision &&
          hash(sealed) !== hash(old))
      ) {
        throw new Error("Source publisher revision rollback or equivocation");
      }
    }
    await atomicWrite(directory, EXPORT_FILE, sealed);
  });
}

/**
 * Offline worker acceptance only: caller supplies a separately pinned public
 * key, an independently trusted allowlist, and a worker-owned private
 * checkpoint directory. No network or runtime worker integration.
 *
 * Initial acceptance requires explicit operator bootstrap. Persist/fsync the
 * checkpoint BEFORE returning sources. Deleting or losing a checkpoint fails
 * closed on subsequent calls; never auto-bootstrap on missing state.
 */
export async function acceptDormantSourceFile(
  publisherDirectory: string,
  checkpointDirectory: string,
  trustedPolicy: ApprovedFetchPolicy,
  pinnedPublisherKey: KeyObject,
  operatorInitialBootstrap = false,
  independentAnchor?: IndependentSourceRevisionAnchor,
): Promise<readonly RegisteredResearchSource[]> {
  await checkDirectory(publisherDirectory);
  return exclusive(checkpointDirectory, "consumer", async () => {
    const rawCheckpoint = await readPrivateJson(checkpointDirectory, CHECKPOINT_FILE);
    if (rawCheckpoint === null && !operatorInitialBootstrap) {
      throw new Error("Worker checkpoint absent; explicit operator recovery required");
    }
    const checkpoint = rawCheckpoint === null ? null : checkpointFrom(rawCheckpoint);
    const signed = await readPrivateJson(publisherDirectory, EXPORT_FILE);
    const { sealed, sources } = verifyDormantSourceSignature(
      signed,
      trustedPolicy,
      pinnedPublisherKey,
      checkpoint ?? { sourceRevision: 1, hostApprovalRevision: 1 },
    );
    const digest = hash(sealed);
    if (
      checkpoint &&
      checkpoint.sourceRevision === sealed.export.sourceRevision &&
      checkpoint.hostApprovalRevision === sealed.export.hostApprovalRevision &&
      checkpoint.envelopeSha256 !== digest
    ) {
      throw new Error("Worker checkpoint equivocation detected");
    }
    // A separately protected, durable, atomic high-water anchor must advance
    // BEFORE the local checkpoint and BEFORE any sources are returned. If the
    // anchor fails, acceptance fails closed. This optional offline interface
    // does not enable a worker; productive integration MUST supply an anchor.
    if (independentAnchor) {
      await independentAnchor.advance({
        sourceRevision: sealed.export.sourceRevision,
        hostApprovalRevision: sealed.export.hostApprovalRevision,
        envelopeSha256: digest,
      });
    }
    await atomicWrite(checkpointDirectory, CHECKPOINT_FILE, {
      version: 1,
      sourceRevision: sealed.export.sourceRevision,
      hostApprovalRevision: sealed.export.hostApprovalRevision,
      envelopeSha256: digest,
    } satisfies DurableCheckpoint);
    return sources;
  });
}

/**
 * Read a signed envelope from an operator-provisioned, read-only group handoff.
 * Unlike the private consumer inbox, this directory may belong to another UID:
 * the worker's dedicated group can only traverse/read, NEVER modify it.
 * Mounted stage and its file must not be accessible to other users.
 */
async function readHandoffEnvelope(directory: string): Promise<unknown> {
  if (!directory.startsWith("/") || resolve(directory) !== directory) {
    throw new Error("Source handoff path refused");
  }
  const [stat, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== directory ||
    (stat.mode & 0o007) !== 0 ||
    (stat.mode & 0o020) !== 0 ||
    (stat.mode & 0o050) !== 0o050 ||
    (typeof process.getgid === "function" && stat.gid !== process.getgid())
  ) {
    throw new Error("Source handoff directory permissions refused");
  }
  const file = await open(
    join(directory, EXPORT_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const entry = await file.stat();
    if (
      !entry.isFile() ||
      entry.nlink !== 1 ||
      entry.size < 2 ||
      entry.size > MAX_FILE_BYTES ||
      (entry.mode & 0o027) !== 0 ||
      (entry.mode & 0o040) === 0 ||
      (typeof process.getgid === "function" && entry.gid !== process.getgid())
    ) {
      throw new Error("Source handoff file permissions refused");
    }
    return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await file.close();
  }
}

/**
 * Explicit handoff from a read-only, different-UID staging mount into the
 * worker's private inbox. Signature and current externally approved hosts
 * are checked BEFORE creating or replacing the private file.
 *
 * Does NOT advance the independent high-water anchor or release sources:
 * acceptDormantSourceFile must still perform that operation before HTTPS.
 */
export async function importSignedSourceHandoff(
  stagingDirectory: string,
  privateInboxDirectory: string,
  trustedPolicy: ApprovedFetchPolicy,
  pinnedPublisherKey: KeyObject,
): Promise<{ sourceRevision: number; hostApprovalRevision: number }> {
  const raw = await readHandoffEnvelope(stagingDirectory);
  const { sealed } = verifyDormantSourceSignature(raw, trustedPolicy, pinnedPublisherKey, {
    sourceRevision: 1,
    hostApprovalRevision: 1,
  });
  await exclusive(privateInboxDirectory, "consumer", async () => {
    const previous = await readPrivateJson(privateInboxDirectory, EXPORT_FILE);
    if (previous !== null) {
      // Only for validating the PREVIOUS signature, not current host grants.
      if (
        !previous ||
        typeof previous !== "object" ||
        !("export" in previous) ||
        !previous.export ||
        typeof previous.export !== "object" ||
        !("allowedHosts" in previous.export) ||
        !Array.isArray(previous.export.allowedHosts)
      ) {
        throw new Error("Previous inbox export unavailable");
      }
      const prior = verifyDormantSourceSignature(
        previous,
        { enabled: true, hosts: previous.export.allowedHosts },
        pinnedPublisherKey,
      ).sealed;
      if (
        sealed.export.sourceRevision < prior.export.sourceRevision ||
        sealed.export.hostApprovalRevision < prior.export.hostApprovalRevision ||
        (sealed.export.sourceRevision === prior.export.sourceRevision &&
          sealed.export.hostApprovalRevision === prior.export.hostApprovalRevision &&
          hash(sealed) !== hash(prior))
      ) {
        throw new Error("Source handoff rollback or equivocation");
      }
    }
    await atomicWrite(privateInboxDirectory, EXPORT_FILE, sealed);
  });
  return {
    sourceRevision: sealed.export.sourceRevision,
    hostApprovalRevision: sealed.export.hostApprovalRevision,
  };
}
