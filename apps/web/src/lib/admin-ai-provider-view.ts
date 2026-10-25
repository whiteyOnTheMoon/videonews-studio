/**
 * P1-09: browser-safe provider metadata schema. Never carry API keys,
 * encrypted envelopes, request IDs, partial key fingerprints or secrets.
 */
export type AdminAiProvider = "openai" | "google_gemini";

export type AdminAiProviderView = {
  provider: AdminAiProvider;
  selectedModel: string;
  configured: boolean;
  active: false;
};

const allowedModels: Record<AdminAiProvider, readonly string[]> = {
  openai: ["gpt-6-luna", "gpt-6.1-sol"],
  google_gemini: ["gemini-3.8-flash-tts"],
};

export function parseAdminAiProviders(body: unknown): AdminAiProviderView[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const wrapper = body as Record<string, unknown>;
  if (Object.keys(wrapper).length !== 1 || !Array.isArray(wrapper.providers)) return null;
  if (wrapper.providers.length !== 2) return null;
  const providers: AdminAiProviderView[] = [];
  const seen = new Set<AdminAiProvider>();
  for (const item of wrapper.providers as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).length !== 4 ||
      !["provider", "selectedModel", "configured", "active"].every((name) =>
        Object.hasOwn(row, name),
      ) ||
      (row.provider !== "openai" && row.provider !== "google_gemini") ||
      typeof row.selectedModel !== "string" ||
      !allowedModels[row.provider].includes(row.selectedModel) ||
      typeof row.configured !== "boolean" ||
      row.active !== false ||
      seen.has(row.provider)
    ) {
      return null;
    }
    seen.add(row.provider);
    providers.push({
      provider: row.provider,
      selectedModel: row.selectedModel,
      configured: row.configured,
      active: false,
    });
  }
  return providers.sort((a, b) => a.provider.localeCompare(b.provider));
}
