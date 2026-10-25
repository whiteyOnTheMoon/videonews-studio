import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Dormant P1-09 file-based master key custody boundary.
 * This is NOT imported from the running API. No key is provisioned or
 * generated, and no environment variable contains the key material.
 */
export const PROVIDER_MASTER_KEY_DIRECTORY = "/run/secrets/vns";
export const PROVIDER_MASTER_KEY_FILENAME = "provider-master-key";

const UNAVAILABLE = "Provider master key unavailable";

function privateOwner(stats: {
  uid: number;
  mode: number;
}): boolean {
  const currentUid = process.getuid?.();
  return (
    currentUid !== undefined &&
    stats.uid === currentUid &&
    (stats.mode & 0o077) === 0
  );
}

/**
 * Read exactly 32 raw binary bytes from a trusted, private directory.
 * Always clears the temporary Buffer after the callback settles.
 *
 * The callback MUST NOT retain the supplied Buffer or export secret bytes.
 * Future runtime wiring requires an independently approved deployment.
 */
export async function withProviderMasterKey<T>(
  operation: (masterKey: Buffer) => T | Promise<T>,
  trustedDirectory = PROVIDER_MASTER_KEY_DIRECTORY,
): Promise<T> {
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  let key: Buffer | undefined;
  try {
    if (
      typeof trustedDirectory !== "string" ||
      !isAbsolute(trustedDirectory) ||
      resolve(trustedDirectory) !== trustedDirectory
    ) {
      throw new Error(UNAVAILABLE);
    }

    const directory = await lstat(trustedDirectory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !privateOwner(directory)
    ) {
      throw new Error(UNAVAILABLE);
    }

    const secretPath = join(trustedDirectory, PROVIDER_MASTER_KEY_FILENAME);
    opened = await open(
      secretPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    const file = await opened.stat();
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      !privateOwner(file) ||
      (file.mode & 0o777) !== 0o400 &&
        (file.mode & 0o777) !== 0o600 ||
      file.nlink !== 1 ||
      file.size !== 32
    ) {
      throw new Error(UNAVAILABLE);
    }

    key = await opened.readFile();
    if (key.length !== 32) throw new Error(UNAVAILABLE);

    await opened.close();
    opened = undefined;
    return await operation(key);
  } catch {
    // Never expose file paths, OS errors, keys or callback error contents.
    throw new Error(UNAVAILABLE);
  } finally {
    if (opened) await opened.close().catch(() => undefined);
    key?.fill(0);
  }
}
