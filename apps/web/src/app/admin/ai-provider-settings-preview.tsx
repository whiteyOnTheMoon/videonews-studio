import type { AdminAiProviderView } from "../../lib/admin-ai-provider-view";

type ProviderPlan = {
  provider: "openai" | "google_gemini";
  label: string;
  use: string;
  voicePreview: boolean;
};

const plans: readonly ProviderPlan[] = [
  {
    provider: "openai",
    label: "OpenAI",
    use: "Englische Nachrichtenanalyse und Skripte",
    voicePreview: false,
  },
  {
    provider: "google_gemini",
    label: "Google Gemini",
    use: "Englische Sprecherstimme (TTS-Kandidat)",
    voicePreview: true,
  },
];

/**
 * Strictly NON-INTERACTIVE preparation for the future credential admin UI.
 * No form, state, event handler, network call, or API-key input acceptance.
 * All credential and model controls are disabled even when status is known.
 */
export default function AiProviderSettingsPreview({
  provider,
  status,
}: {
  provider: ProviderPlan["provider"];
  status?: AdminAiProviderView;
}) {
  const plan = plans.find((candidate) => candidate.provider === provider);
  if (!plan) return null;

  const prefix = "ai-preview-" + provider;
  const selectedModel = status?.selectedModel ?? "";

  return (
    <div className="ai-provider-preview" aria-label={plan.label + " – Einstellungen gesperrt"}>
      <strong>{plan.label}</strong>
      <p className="jobs-hint">{plan.use}</p>
      <p className="jobs-hint">
        API-Key:{" "}
        {status
          ? status.configured
            ? "hinterlegt (Inhalt niemals sichtbar)"
            : "nicht hinterlegt"
          : "Status derzeit unbekannt"}
      </p>
      <p className="jobs-hint">Betrieb: deaktiviert</p>
      <fieldset disabled className="ai-provider-fields">
        <legend>Verwaltung – noch nicht freigeschaltet</legend>
        <div className="ai-provider-field">
          <label htmlFor={prefix + "-credential"}>API-Key</label>
          <input
            id={prefix + "-credential"}
            type="password"
            autoComplete="off"
            readOnly
            disabled
            value=""
            placeholder="Eingabe erst nach Freigabe"
          />
          <span className="jobs-hint">
            Schlüssel werden künftig nach dem Speichern nicht mehr angezeigt.
          </span>
        </div>
        <div className="ai-provider-field">
          <label htmlFor={prefix + "-model"}>KI-Modell</label>
          <input
            id={prefix + "-model"}
            type="text"
            value={selectedModel}
            readOnly
            disabled
            placeholder="Noch nicht aus der Datenbank geladen"
          />
        </div>
        <div className="ai-provider-field">
          <label htmlFor={prefix + "-language"}>Videosprache</label>
          <input id={prefix + "-language"} type="text" value="English (en)" readOnly disabled />
        </div>
        {plan.voicePreview ? (
          <div className="ai-provider-field">
            <label htmlFor={prefix + "-voice"}>Sprecherstimme</label>
            <select id={prefix + "-voice"} value="" disabled>
              <option value="">Noch nicht festgelegt</option>
            </select>
          </div>
        ) : null}
        <div className="ai-provider-actions">
          <button type="button" disabled>
            API-Key hinterlegen / ersetzen
          </button>
          <button type="button" disabled>
            API-Key entfernen
          </button>
          <button type="button" disabled>
            Modell übernehmen
          </button>
        </div>
      </fieldset>
      <p className="jobs-hint">
        Vorschau ohne Speicherfunktion. API-Anfragen und Kosten sind gesperrt.
      </p>
    </div>
  );
}
