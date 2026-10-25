import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Git-only cryptographic building block for future admin-managed API keys.
 * No DB, HTTP routes, worker imports, provider SDK or secret-file loading here.
 */
export type AiProvider = "openai" | "google_gemini";

export interface SealedProviderSecret {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function validProvider(value: unknown): value is AiProvider {
  return value === "openai" || value === "google_gemini";
}

function validPlaintext(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 12 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const point = character.charCodeAt(0);
      return point >= 33 && point <= 126;
    })
  );
}

function validMasterKey(key: unknown): key is Buffer {
  return Buffer.isBuffer(key) && key.byteLength === 32;
}

function strictDecode(text: unknown, size?: number): Buffer {
  if (
    typeof text !== "string" ||
    text.length > 800 ||
    text.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(text)
  ) {
    throw new Error("Invalid encrypted provider credential");
  }
  const decoded = Buffer.from(text, "base64url");
  if ((size !== undefined && decoded.length !== size) || decoded.toString("base64url") !== text) {
    throw new Error("Invalid encrypted provider credential");
  }
  return decoded;
}

function associatedData(provider: AiProvider): Buffer {
  return Buffer.from("vns:ai-provider:v1:" + provider, "utf8");
}

export function sealProviderApiKey(
  provider: AiProvider,
  apiKey: string,
  masterKey: Buffer,
): SealedProviderSecret {
  if (!validProvider(provider) || !validPlaintext(apiKey) || !validMasterKey(masterKey)) {
    throw new Error("Invalid provider encryption configuration");
  }
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(apiKey, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 });
    cipher.setAAD(associatedData(provider));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({
      version: 1 as const,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  } finally {
    plaintext.fill(0);
  }
}

export function unsealProviderApiKey(
  provider: AiProvider,
  sealed: unknown,
  masterKey: Buffer,
): string {
  if (!validProvider(provider) || !validMasterKey(masterKey)) {
    throw new Error("Invalid provider encryption configuration");
  }
  if (
    sealed === null ||
    typeof sealed !== "object" ||
    Array.isArray(sealed) ||
    Object.keys(sealed).length !== 4
  ) {
    throw new Error("Invalid encrypted provider credential");
  }
  const record = sealed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !["version", "nonce", "ciphertext", "tag"].every((field) =>
      Object.hasOwn(record, field),
    )
  ) {
    throw new Error("Invalid encrypted provider credential");
  }
  const nonce = strictDecode(record.nonce, 12);
  const ciphertext = strictDecode(record.ciphertext);
  const tag = strictDecode(record.tag, 16);
  if (ciphertext.length < 12 || ciphertext.length > 512) {
    throw new Error("Invalid encrypted provider credential");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 });
    decipher.setAAD(associatedData(provider));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      const output = plaintext.toString("utf8");
      if (!validPlaintext(output)) throw new Error("Invalid decrypted provider credential");
      return output;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    // Never expose raw cryptographic/internal errors or credential contents.
    throw new Error("Encrypted provider credential unavailable");
  }
}

/** Client-readable configuration is deliberately key-free. */
export function publicProviderKeyStatus(value: unknown): {
  provider: AiProvider;
  configured: boolean;
  active: false;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider status");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    !validProvider(row.provider) ||
    typeof row.configured !== "boolean"
  ) {
    throw new Error("Invalid provider status");
  }
  return { provider: row.provider, configured: row.configured, active: false };
}
