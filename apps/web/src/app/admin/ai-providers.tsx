"use client";

import { useEffect, useState } from "react";
import { parseAdminAiProviders, type AdminAiProviderView } from "../../lib/admin-ai-provider-view";
import AiProviderSettingsPreview from "./ai-provider-settings-preview";
import AiProviderEditForm from "./ai-provider-edit-form";
import type { ProviderEditCommand } from "./ai-provider-edit-model";

export default function AiProviders({ readOnlyEnabled, writeEnabled = false }: { readOnlyEnabled: boolean; writeEnabled?: boolean }) {
  const [providers, setProviders] = useState<AdminAiProviderView[]>([]);
  const [loading, setLoading] = useState(readOnlyEnabled);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!readOnlyEnabled) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/admin/ai-providers", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          setError("Admin-Sitzung abgelaufen. Bitte erneut anmelden.");
          return;
        }
        if (!response.ok) throw new Error("Unavailable");
        const json: unknown = await response.json();
        const parsed = parseAdminAiProviders(json);
        if (!parsed) throw new Error("Unexpected response");
        if (!controller.signal.aborted) setProviders(parsed);
      } catch {
        if (!controller.signal.aborted) {
          setError("Anbieterstatus derzeit nicht verfügbar.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [readOnlyEnabled]);

  async function submit(command: ProviderEditCommand): Promise<boolean> {
    if (!writeEnabled || !readOnlyEnabled) return false;
    try {
      const response = await fetch("/api/admin/ai-providers", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(command),
      });
      if (response.status !== 200) return false;
      const result: unknown = await response.json();
      return Boolean(
        result && typeof result === "object" &&
        !Array.isArray(result) &&
        Object.keys(result).length === 2 &&
        "saved" in result && result.saved === true &&
        "active" in result && result.active === false
      );
    } catch {
      return false;
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="ai-providers-title">
      <h2 id="ai-providers-title">KI-Anbieter</h2>
      <p>
        Die geplanten Einstellungen für API-Keys, englische Textmodelle und Sprecherstimmen sind
        sichtbar, bleiben aber vollständig deaktiviert.
      </p>
      <div className="notice" role="status">
        <strong>{writeEnabled ? "Sichere Konfiguration freigeschaltet." : "Schlüsselverwaltung nicht freigeschaltet."}</strong> Es werden keine KI-Anfragen ausgelöst.
      </div>
      {loading ? <p role="status">Lade Anbieterstatus …</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <ul className="jobs-list">
        {(["openai", "google_gemini"] as const).map((provider) => (
          <li key={provider} className="jobs-entry">
            <AiProviderSettingsPreview
              provider={provider}
              status={providers.find((entry) => entry.provider === provider)}
            />
            {writeEnabled && readOnlyEnabled && !loading && !error && providers.find((entry) => entry.provider === provider) ? (
              <AiProviderEditForm
                provider={provider}
                selectedModel={providers.find((entry) => entry.provider === provider)!.selectedModel}
                configured={providers.find((entry) => entry.provider === provider)!.configured}
                ready
                onCommand={submit}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <p>
        Die Ausführung kostenpflichtiger Provider bleibt unabhängig von diesen Einstellungen deaktiviert.
      </p>
    </section>
  );
}
