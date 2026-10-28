import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Application-encrypted prompt envelope for durable PostgreSQL outbox storage.
 * No network, Redis, vendor transport, SQL mutation, or activation path.
 * The 32-byte key must come from an isolated Docker secret, never the queue.
 */
export type EncryptedProviderPrompt = Readonly<{
  version: 1;
  ciphertext: string;
  iv: string;
  tag: string;
  sha256: string;
}>;

const SHA = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const AAD = Buffer.from("videonews-provider-prompt-v1", "ascii");

function denied(): never {
  throw new Error("Provider prompt envelope unavailable");
}

function keyBytes(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) denied();
  return key;
}

function parseB64(value: unknown, exactLength?: number): Buffer {
  if (typeof value !== "string" || !B64.test(value)) denied();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (exactLength !== undefined && bytes.length !== exactLength)
  ) {
    denied();
  }
  return bytes;
}

export function sealProviderPrompt(prompt: string, key: Buffer): EncryptedProviderPrompt {
  keyBytes(key);
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, "utf8") > 32768 ||
    Buffer.byteLength(prompt, "utf8") < 1
  )
    denied();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(prompt, "utf8"), cipher.final()]);
  const sha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
  return Object.freeze({
    version: 1,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    sha256,
  });
}

export function openProviderPrompt(envelope: EncryptedProviderPrompt, key: Buffer): string {
  keyBytes(key);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 5 ||
    envelope.version !== 1 ||
    typeof envelope.sha256 !== "string" ||
    !SHA.test(envelope.sha256)
  ) {
    denied();
  }
  try {
    const iv = parseB64(envelope.iv, 12);
    const tag = parseB64(envelope.tag, 16);
    const ciphertext = parseB64(envelope.ciphertext);
    if (ciphertext.length < 1 || ciphertext.length > 32768) denied();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const prompt = clear.toString("utf8");
    const actual = Buffer.from(prompt, "utf8");
    if (!actual.equals(clear) || !prompt.trim() || actual.length > 32768) denied();
    const digest = createHash("sha256").update(clear).digest();
    if (!timingSafeEqual(digest, Buffer.from(envelope.sha256, "hex"))) denied();
    return prompt;
  } catch {
    denied();
  }
}
