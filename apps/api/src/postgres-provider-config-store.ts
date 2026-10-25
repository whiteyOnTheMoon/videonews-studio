import type { Pool } from "pg";
import type {
  ProviderConfigStore,
  ProviderMetadata,
  ProviderMutation,
} from "./admin-provider-configuration.js";
import type { AiProvider } from "./provider-credential-crypto.js";

// Dormant CI-only adapter. Do NOT import in the running API entrypoint.
// A future Pool must use a dedicated LOGIN that is separately granted
// vns_provider_config_writer (currently NOLOGIN / NO members).
const MODELS: Record<AiProvider, readonly string[]> = {
  openai: ["gpt-6-luna", "gpt-6.1-sol"],
  google_gemini: ["gemini-3.8-flash-tts"],
};

function validateProvider(provider: unknown): provider is AiProvider {
  return provider === "openai" || provider === "google_gemini";
}

function decodeCanonicalBase64Url(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,800}$/.test(value)) {
    throw new Error("Invalid sealed provider envelope");
  }
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value || (size !== undefined && result.length !== size)) {
    throw new Error("Invalid sealed provider envelope");
  }
  return result;
}

function validateSealed(value: unknown): [Buffer, Buffer, Buffer] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid sealed provider envelope");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    row.version !== 1 ||
    !["version", "nonce", "ciphertext", "tag"].every((field) =>
      Object.hasOwn(row, field),
    )
  ) {
    throw new Error("Invalid sealed provider envelope");
  }
  const nonce = decodeCanonicalBase64Url(row.nonce, 12);
  const encrypted = decodeCanonicalBase64Url(row.ciphertext);
  const tag = decodeCanonicalBase64Url(row.tag, 16);
  if (encrypted.length < 12 || encrypted.length > 512) {
    throw new Error("Invalid sealed provider envelope");
  }
  return [nonce, encrypted, tag];
}

/** PostgreSQL wraps the mutation plus its secret-free audit event in ONE transaction. */
export class PostgresProviderConfigStore implements ProviderConfigStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async list(): Promise<ProviderMetadata[]> {
    try {
      const result = await this.pool.query<ProviderMetadata>(
        "SELECT provider, \"selectedModel\", configured " +
          "FROM vns.admin_list_ai_providers()",
      );
      return result.rows;
    } catch {
      throw new Error("Provider metadata unavailable");
    }
  }

  async mutateWithAudit(change: ProviderMutation): Promise<void> {
    if (!validateProvider(change.provider)) {
      throw new Error("Invalid provider mutation");
    }
    let model: string | null = null;
    let envelope: [Buffer, Buffer, Buffer] | null = null;
    if (change.action === "set_key") {
      if (change.selectedModel !== undefined) {
        throw new Error("Invalid provider mutation");
      }
      envelope = validateSealed(change.sealedKey);
    } else if (change.action === "set_model") {
      if (
        change.sealedKey !== undefined ||
        typeof change.selectedModel !== "string" ||
        !MODELS[change.provider].includes(change.selectedModel)
      ) {
        throw new Error("Invalid provider mutation");
      }
      model = change.selectedModel;
    } else if (change.action === "remove_key") {
      if (change.selectedModel !== undefined || change.sealedKey !== undefined) {
        throw new Error("Invalid provider mutation");
      }
    } else {
      throw new Error("Invalid provider mutation");
    }

    try {
      await this.pool.query(
        "SELECT vns.admin_mutate_ai_provider(" +
          "$1::text,$2::text,$3::text,$4::bytea,$5::bytea,$6::bytea)",
        [
          change.provider,
          change.action,
          model,
          envelope?.[0] ?? null,
          envelope?.[1] ?? null,
          envelope?.[2] ?? null,
        ],
      );
    } catch {
      // No SQLSTATE diagnostics, ciphertext, session cookies or endpoints.
      throw new Error("Provider change unavailable");
    }
  }
}

