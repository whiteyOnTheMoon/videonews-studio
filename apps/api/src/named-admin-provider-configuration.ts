import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";
import {
  parseProviderAdminCommand,
  readLimitedJson,
  respond,
  validatePublicProviderList,
  type ProviderMutation,
  type ProviderMetadata,
} from "./admin-provider-configuration.js";
import { sealProviderApiKey } from "./provider-credential-crypto.js";

/** A future named store must not expose the legacy shared-admin write method. */
export interface NamedProviderStore {
  list(): Promise<ProviderMetadata[]>;
  mutateAsNamedAdmin(change: ProviderMutation, identity: EditorIdentity): Promise<void>;
}

/**
 * Offline-only named provider HTTP boundary. Never wired from index.ts.
 * A real personal editor session is resolved server-side on EVERY request.
 * The shared admin cookie is intentionally not an authorization source.
 */
export class NamedAdminProviderConfiguration {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly origin: Pick<AdminAuth, "originAllowed">,
    private readonly store: NamedProviderStore,
    private readonly masterKey: Buffer,
    private readonly limiter: { allow(): Promise<boolean> },
  ) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new Error("Invalid provider encryption configuration");
    }
    if (!limiter || typeof limiter.allow !== "function") {
      throw new Error("Named provider rate admission is required");
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== "/admin/ai-providers") return false;

    let identity: EditorIdentity | null;
    try {
      identity = await this.editor.authenticatedAdminIdentity(request);
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!identity || identity.role !== "admin") {
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
    if (!this.origin.originAllowed(request)) {
      respond(response, 403, { error: "forbidden" });
      return true;
    }

    // The shared SQL quota is mandatory and checked before reading any key.
    try {
      if ((await this.limiter.allow()) !== true) {
        respond(response, 429, { error: "too_many_requests" });
        return true;
      }
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
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
        await this.store.mutateAsNamedAdmin(
          { action: "set_key", provider: command.provider, sealedKey },
          identity,
        );
      } else if (command.action === "set_model") {
        await this.store.mutateAsNamedAdmin(
          { action: "set_model", provider: command.provider, selectedModel: command.model },
          identity,
        );
      } else {
        await this.store.mutateAsNamedAdmin(
          { action: "remove_key", provider: command.provider },
          identity,
        );
      }
      respond(response, 200, { saved: true, active: false });
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
