"use client";

import { useEffect, useState } from "react";
import { parseAdminAiProviders, type AdminAiProviderView } from "../../lib/admin-ai-provider-view";
import AiProviderSettingsPreview from "./ai-provider-settings-preview";

export default function AiProviders({ readOnlyEnabled }: { readOnlyEnabled: boolean }) {
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

  return (
    <section className="jobs-section" aria-labelledby="ai-providers-title">
      <h2 id="ai-providers-title">KI-Anbieter</h2>
      <p>
        Die geplanten Einstellungen für API-Keys, englische Textmodelle und Sprecherstimmen sind
        sichtbar, bleiben aber vollständig deaktiviert.
      </p>
      <div className="notice" role="status">
        <strong>Schlüsselverwaltung noch nicht freigeschaltet.</strong> Bitte keine API-Schlüssel in
        Chat, GitHub oder andere Formulare eintragen. Es werden keine KI-Anfragen ausgelöst.
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
          </li>
        ))}
      </ul>
      <p>
        Schlüssel eintragen, austauschen oder löschen sowie das Modell ändern wird erst nach
        gesonderter Sicherheits- und Betriebsfreigabe möglich.
      </p>
    </section>
  );
}
