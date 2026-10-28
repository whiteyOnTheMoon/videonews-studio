import { createDecipheriv } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Pool } from "pg";
import type { NativeProvider } from "./provider-native-usage.js";
import type { TrustedProviderCredentialScope } from "./provider-one-shot-text-coordinator.js";

/**
 * P1-09: isolated, default-OFF worker credential scope. Not mounted in
 * worker entrypoints, no LOGIN/secret provision, no paid dispatch.
 * The SQL function only returns one sealed envelope after a one-shot
 * dispatch claim, and persists an immutable single-access audit.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_DIRECTORY = "/run/secrets/vns";
const KEY_FILE = "provider-master-key";
const FAIL = "Provider credential unavailable";

export type SealedWorkerCredential = Readonly<{
  format_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}>;

function privateOwner(stats: { uid: number; mode: number }): boolean {
  return process.getuid?.() === stats.uid && (stats.mode & 0o077) === 0;
}

/** A separate worker process MUST use its own isolated secret-file mount. */
export async function withWorkerMasterKey<T>(
  operation: (key: Buffer) => Promise<T>,
  directory = KEY_DIRECTORY,
): Promise<T> {
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  let key: Buffer | undefined;
  try {
    if (
      typeof directory !== "string" ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory
    ) throw Error(FAIL);
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !privateOwner(dir) ||
        (dir.mode & 0o777) !== 0o700) throw Error(FAIL);
    opened = await open(
      join(directory, KEY_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const file = await opened.stat();
    if (
      !file.isFile() ||
      !privateOwner(file) ||
      file.nlink !== 1 ||
      file.size !== 32 ||
      ![0o400, 0o600].includes(file.mode & 0o777)
    ) throw Error(FAIL);
    key = await opened.readFile();
    if (key.length !== 32) throw Error(FAIL);
    await opened.close();
    opened = undefined;
    return await operation(key);
  } catch {
    throw Error(FAIL);
  } finally {
    key?.fill(0);
    if (opened) await opened.close().catch(() => undefined);
  }
}

/** Caller cannot pass raw credentials; only SQL-bound encrypted envelope. */
export function unsealWorkerCredential(
  provider: NativeProvider,
  sealed: SealedWorkerCredential,
  masterKey: Buffer,
): Buffer {
  const invalid = () => { throw Error(FAIL); };
  if (
    !["openai", "google_gemini"].includes(provider) ||
    !Buffer.isBuffer(masterKey) ||
    masterKey.length !== 32 ||
    !sealed ||
    Object.keys(sealed).length !== 4 ||
    sealed.format_version !== 1 ||
    !Buffer.isBuffer(sealed.nonce) ||
    sealed.nonce.length !== 12 ||
    !Buffer.isBuffer(sealed.ciphertext) ||
    sealed.ciphertext.length < 12 ||
    sealed.ciphertext.length > 512 ||
    !Buffer.isBuffer(sealed.auth_tag) ||
    sealed.auth_tag.length !== 16
  ) invalid();
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, sealed.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from("vns:ai-provider:v1:" + provider));
    decipher.setAuthTag(sealed.auth_tag);
    const plaintext = Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]);
    if (
      plaintext.length < 12 ||
      plaintext.length > 512 ||
      ![...plaintext].every((c) => c >= 33 && c <= 126)
    ) {
      plaintext.fill(0);
      invalid();
    }
    return plaintext;
  } catch {
    throw Error(FAIL);
  }
}

export type WorkerMasterKeyScope = <T>(
  operation: (key: Buffer) => Promise<T>,
) => Promise<T>;

export function dormantPostClaimCredentialScope(
  db: Pick<Pool, "query">,
  enabled = false,
  withKey: WorkerMasterKeyScope = withWorkerMasterKey,
): TrustedProviderCredentialScope {
  if (enabled !== true || !db || typeof db.query !== "function" ||
      typeof withKey !== "function") {
    throw Error("Provider credential scope disabled");
  }
  return Object.freeze({
    async withCredential<T>(
      reservationId: string,
      provider: NativeProvider,
      operation: (secret: string) => Promise<T>,
    ): Promise<T> {
      if (
        !UUID.test(reservationId) ||
        !["openai", "google_gemini"].includes(provider) ||
        typeof operation !== "function"
      ) throw Error(FAIL);
      let sealed: SealedWorkerCredential | undefined;
      let secretBytes: Buffer | undefined;
      try {
        // No KEK reads until a PostgreSQL-authenticated one-shot read
        // succeeds. No direct SELECT on credential tables is permitted.
        const result = await db.query<SealedWorkerCredential>(
          "SELECT format_version,nonce,ciphertext,auth_tag " +
            "FROM vns.claimed_provider_sealed_key($1::uuid,$2::text)",
          [reservationId, provider],
        );
        if (result.rows.length !== 1) throw Error(FAIL);
        sealed = result.rows[0];
        return await withKey(async (key) => {
          secretBytes = unsealWorkerCredential(provider, sealed!, key);
          const ephemeral = secretBytes.toString("ascii");
          return operation(ephemeral);
        });
      } catch {
        throw Error(FAIL);
      } finally {
        secretBytes?.fill(0);
        if (sealed) {
          if (Buffer.isBuffer(sealed.nonce)) sealed.nonce.fill(0);
          if (Buffer.isBuffer(sealed.ciphertext)) sealed.ciphertext.fill(0);
          if (Buffer.isBuffer(sealed.auth_tag)) sealed.auth_tag.fill(0);
        }
      }
    },
  });
}
