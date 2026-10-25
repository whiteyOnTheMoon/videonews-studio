import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import {
  sealProviderApiKey,
  type AiProvider,
  type SealedProviderSecret,
} from "./provider-credential-crypto.js";

// NOT wired to server.ts or index.ts. No real secrets may be submitted.
// A later deployment requires a dedicated audited PostgreSQL store and KEK custody.
export interface ProviderMetadata {
  provider: AiProvider;
  selectedModel: string;
  configured: boolean;
}
export interface ProviderMutation {
  provider: AiProvider;
  action: "set_key" | "remove_key" | "set_model";
  sealedKey?: SealedProviderSecret;
  selectedModel?: string;
}
export interface ProviderConfigStore {
  list(): Promise<ProviderMetadata[]>;
  // A future implementation MUST atomically persist an audit event with each mutation.
  mutateWithAudit(change: ProviderMutation): Promise<void>;
}

const MODELS: Record<AiProvider, readonly string[]> = Object.freeze({
  openai: Object.freeze(["gpt-6-luna", "gpt-6.1-sol"]),
  google_gemini: Object.freeze(["gemini-3.8-flash-tts"]),
});
const PROVIDERS: readonly AiProvider[] = ["openai", "google_gemini"];

type Command =
  | { action: "set_key"; provider: AiProvider; apiKey: string }
  | { action: "remove_key"; provider: AiProvider }
  | { action: "set_model"; provider: AiProvider; model: string };

function hasExactKeys(row: Record<string, unknown>, fields: readonly string[]) {
  return (
    Object.keys(row).length === fields.length &&
    fields.every((field) => Object.hasOwn(row, field))
  );
}

export function parseProviderAdminCommand(input: unknown): Command | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (
    typeof row.provider !== "string" ||
    !PROVIDERS.some((candidate) => candidate === row.provider)
  ) {
    return null;
  }
  const provider = row.provider as AiProvider;
  if (
    row.action === "set_key" &&
    hasExactKeys(row, ["action", "provider", "apiKey"]) &&
    typeof row.apiKey === "string" &&
    row.apiKey.length >= 12 &&
    row.apiKey.length <= 512 &&
    [...row.apiKey].every((character) => {
      const point = character.charCodeAt(0);
      return point >= 33 && point <= 126;
    })
  ) {
    return { action: "set_key", provider, apiKey: row.apiKey };
  }
  if (
    row.action === "remove_key" &&
    hasExactKeys(row, ["action", "provider"])
  ) {
    return { action: "remove_key", provider };
  }
  if (
    row.action === "set_model" &&
    hasExactKeys(row, ["action", "provider", "model"]) &&
    typeof row.model === "string" &&
    MODELS[provider].includes(row.model)
  ) {
    return { action: "set_model", provider, model: row.model };
  }
  return null;
}

export function validatePublicProviderList(data: unknown): ProviderMetadata[] {
  if (!Array.isArray(data) || data.length !== 2) {
    throw new Error("Invalid provider configuration");
  }
  const found = new Set<AiProvider>();
  const output: ProviderMetadata[] = [];
  for (const candidate of data as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Invalid provider configuration");
    }
    const row = candidate as Record<string, unknown>;
    if (
      !hasExactKeys(row, ["provider", "selectedModel", "configured"]) ||
      !PROVIDERS.some((provider) => provider === row.provider) ||
      typeof row.selectedModel !== "string" ||
      typeof row.configured !== "boolean"
    ) {
      throw new Error("Invalid provider configuration");
    }
    const provider = row.provider as AiProvider;
    if (found.has(provider) || !MODELS[provider].includes(row.selectedModel)) {
      throw new Error("Invalid provider configuration");
    }
    found.add(provider);
    output.push({
      provider,
      selectedModel: row.selectedModel,
      configured: row.configured,
    });
  }
  return output;
}

async function readLimitedJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return null;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 1024) return null;
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function respond(response: ServerResponse, status: number, data: object) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(data));
}

/**
 * Admin-only API contract. Deliberately NOT reachable from the production
 * server; only fake stores are used by CI. No secret in GET, POST or error JSON.
 */
export class AdminProviderConfiguration {
  constructor(
    private readonly auth: Pick<AdminAuth, "hasAdminSession" | "originAllowed">,
    private readonly store: ProviderConfigStore,
    private readonly masterKey: Buffer,
  ) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new Error("Invalid provider encryption configuration");
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== "/admin/ai-providers") return false;
    if (!this.auth.hasAdminSession(request)) {
      respond(response, 401, { error: "unauthorized" });
      return true;
    }

    if (request.method === "GET") {
      try {
        const providers = validatePublicProviderList(await this.store.list());
        respond(response, 200, {
          providers: providers.map((provider) => ({ ...provider, active: false as const })),
        });
      } catch {
        respond(response, 503, { error: "temporarily_unavailable" });
      }
      return true;
    }

    if (request.method !== "POST") {
      respond(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!this.auth.originAllowed(request)) {
      respond(response, 403, { error: "forbidden" });
      return true;
    }

    const command = parseProviderAdminCommand(await readLimitedJson(request));
    if (!command) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }

    try {
      if (command.action === "set_key") {
        const sealedKey = sealProviderApiKey(command.provider, command.apiKey, this.masterKey);
        await this.store.mutateWithAudit({
          action: "set_key",
          provider: command.provider,
          sealedKey,
        });
      } else if (command.action === "set_model") {
        await this.store.mutateWithAudit({
          action: "set_model",
          provider: command.provider,
          selectedModel: command.model,
        });
      } else {
        await this.store.mutateWithAudit({
          action: "remove_key",
          provider: command.provider,
        });
      }
      // Neither ciphertext nor plaintext nor partial key fingerprints reach the browser.
      respond(response, 200, { saved: true, active: false });
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
