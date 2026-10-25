import type { AdminAiProvider } from "../../lib/admin-ai-provider-view";

/** A future browser UI may emit only commands the internal API already knows. */
export type ProviderEditCommand =
  | { action: "set_key"; provider: AdminAiProvider; apiKey: string }
  | { action: "remove_key"; provider: AdminAiProvider }
  | { action: "set_model"; provider: AdminAiProvider; model: string };

export const PROVIDER_MODEL_CHOICES: Record<AdminAiProvider, readonly string[]> = {
  openai: ["gpt-6-luna", "gpt-6.1-sol"],
  google_gemini: ["gemini-3.8-flash-tts"],
};

function knownProvider(provider: unknown): provider is AdminAiProvider {
  return provider === "openai" || provider === "google_gemini";
}

export function makeKeyCommand(provider: unknown, apiKey: unknown): ProviderEditCommand | null {
  if (!knownProvider(provider) || typeof apiKey !== "string") return null;
  if (
    apiKey.length < 12 ||
    apiKey.length > 512 ||
    [...apiKey].some((character) => {
      const code = character.charCodeAt(0);
      return code < 33 || code > 126;
    })
  ) {
    return null;
  }
  return { action: "set_key", provider, apiKey };
}

export function makeModelCommand(provider: unknown, model: unknown): ProviderEditCommand | null {
  if (
    !knownProvider(provider) ||
    typeof model !== "string" ||
    !PROVIDER_MODEL_CHOICES[provider].includes(model)
  ) {
    return null;
  }
  return { action: "set_model", provider, model };
}

export function makeRemoveCommand(
  provider: unknown,
  configured: boolean,
  explicitlyConfirmed: boolean,
): ProviderEditCommand | null {
  if (!knownProvider(provider) || !configured || !explicitlyConfirmed) return null;
  return { action: "remove_key", provider };
}
