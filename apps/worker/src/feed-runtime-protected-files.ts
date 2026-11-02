import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";

/**
 * Operator-provisioned bind-mounted files in the feed observer/consumer.
 * Docker read_only does not enforce the underlying inode owner, hardlink
 * count or mode. The actual runtime principal must be UID/GID 10002.
 */
const WORKER_UID = 10002;
const WORKER_GID = 10002;

interface Restriction {
  readonly ownerUid: number;
  readonly ownerGid?: number;
  readonly mode: number;
  readonly minBytes: number;
  readonly maxBytes: number;
}

function restrictedFile(path: string, policy: Restriction, errorMessage: string): string {
  let fd: number | undefined;
  try {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.includes("\0") ||
      path.includes("/../") ||
      path.includes("/./") ||
      process.getuid?.() !== WORKER_UID ||
      process.getgid?.() !== WORKER_GID
    ) {
      throw new Error("Runtime file path or identity refused");
    }

    // O_NOFOLLOW prevents a link as the leaf; realpath comparison also
    // forbids an unexpected symlink in the ancestor chain.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== policy.ownerUid ||
      (policy.ownerGid !== undefined && before.gid !== policy.ownerGid) ||
      (before.mode & 0o777) !== policy.mode ||
      before.size < policy.minBytes ||
      before.size > policy.maxBytes ||
      realpathSync(path) !== path
    ) {
      throw new Error("Runtime file ownership or layout refused");
    }
    const value = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (
      Buffer.byteLength(value, "utf8") !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.nlink !== after.nlink
    ) {
      throw new Error("Runtime file changed during read");
    }
    return value;
  } catch {
    // Never reveal any path, inode metadata, credential or raw filesystem error.
    throw new Error(errorMessage);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Exactly the pre-existing 0400 feed/anchor/Redis secrets owned by worker
 * UID10002; no trimming of internal spaces, binary bytes or unsafe chars.
 */
export function readFeedSecretFile(path: string): string {
  const text = restrictedFile(
    path,
    { ownerUid: WORKER_UID, mode: 0o400, minBytes: 40, maxBytes: 257 },
    "Feed runtime secret unavailable",
  );
  const password = text.trimEnd();
  if (password.length < 40 || password.length > 256 || !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("Feed runtime secret unavailable");
  }
  return password;
}

/**
 * An independently pinned public Ed25519 key or external TLS CA.
 * Root-owned 0440 with worker-group read permission is the operator contract;
 * the runtime UID may not replace these trust anchors.
 */
export function readPinnedFeedTrustFile(path: string): string {
  return restrictedFile(
    path,
    { ownerUid: 0, ownerGid: WORKER_GID, mode: 0o440, minBytes: 16, maxBytes: 16384 },
    "Pinned feed trust material unavailable",
  );
}
