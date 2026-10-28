"use client";

import { useState, type FormEvent } from "react";

type ReviewType = "review_price" | "review_fx";

/** Only records reviewed snapshots; no method can activate an AI provider. */
export default function AiPriceFxReview({ enabled }: { enabled: boolean }) {
  const [type, setType] = useState<ReviewType>("review_price");
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [priceVersion, setPriceVersion] = useState("");
  const [inputRate, setInputRate] = useState("");
  const [cacheRate, setCacheRate] = useState("");
  const [outputRate, setOutputRate] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [expires, setExpires] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  if (!enabled) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult("");
    try {
      if (!expires) throw new Error("expiry");
      const expiresAt = new Date(expires).toISOString();
      let payload: object;
      if (type === "review_price") {
        payload = {
          action: "review_price",
          provider,
          model: model.trim(),
          priceVersion: priceVersion.trim(),
          inputMicroUsdPerMillion: inputRate.trim(),
          cachedMicroUsdPerMillion: cacheRate.trim(),
          outputMicroUsdPerMillion: outputRate.trim(),
          expiresAt,
          sourceReference: source.trim(),
        };
      } else {
        // Exact fixed-point conversion: conservative EUR per USD * 10^9.
        const match = /^(\d{1,2})(?:\.(\d{1,9}))?$/.exec(fxRate.trim());
        if (!match) throw new Error("fx");
        const nanos = BigInt(match[1]!) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
        if (nanos < 1n || nanos > 10_000_000_000n) throw new Error("fx");
        payload = {
          action: "review_fx",
          microEurPerMicroUsdNanos: nanos.toString(),
          expiresAt,
          sourceReference: source.trim(),
        };
      }
      const response = await fetch("/api/admin/ai-provider-pricing", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("rejected");
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("reviewed" in data) ||
        data.reviewed !== true ||
        !("active" in data) ||
        data.active !== false
      ) {
        throw new Error("invalid");
      }
      setResult("Prüfeintrag gespeichert. Provider und Budgets bleiben deaktiviert.");
    } catch {
      setResult("Eintrag abgelehnt. Angaben, persönliche Sitzung und Freigaben prüfen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="review-prices-title">
      <h2 id="review-prices-title">Geprüfte KI-Preise und Wechselkurse</h2>
      <p>
        Erfasse ausschließlich selbst anhand der angegebenen Quelle überprüfte Werte. Diese Funktion
        speichert unveränderliche Versionen, aktiviert aber keine KI-Anfragen.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="review-kind">Art des Eintrags</label>{" "}
          <select
            id="review-kind"
            value={type}
            onChange={(event) => setType(event.target.value as ReviewType)}
          >
            <option value="review_price">Modellpreise (USD)</option>
            <option value="review_fx">Konservative USD/EUR-Obergrenze</option>
          </select>
        </p>
        {type === "review_price" ? (
          <>
            <p>
              <label htmlFor="review-provider">Anbieter</label>{" "}
              <select
                id="review-provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="openai">OpenAI</option>
                <option value="google_gemini">Google Gemini</option>
              </select>
            </p>
            <p>
              <label htmlFor="review-model">Genaue Modell-ID</label>{" "}
              <input
                id="review-model"
                required
                value={model}
                maxLength={80}
                onChange={(event) => setModel(event.target.value)}
              />
            </p>
            <p>
              <label htmlFor="review-version">Eindeutige Preisversion</label>{" "}
              <input
                id="review-version"
                required
                value={priceVersion}
                minLength={12}
                maxLength={80}
                onChange={(event) => setPriceVersion(event.target.value)}
              />
            </p>
            <p>Preise in Mikro-USD je 1 Million Tokens (1.000.000 Mikro-USD = 1 USD).</p>
            <p>
              <label htmlFor="review-input">Input</label>{" "}
              <input
                id="review-input"
                required
                inputMode="numeric"
                value={inputRate}
                onChange={(event) => setInputRate(event.target.value)}
              />
            </p>
            <p>
              <label htmlFor="review-cached">Cached Input</label>{" "}
              <input
                id="review-cached"
                required
                inputMode="numeric"
                value={cacheRate}
                onChange={(event) => setCacheRate(event.target.value)}
              />
            </p>
            <p>
              <label htmlFor="review-output">Output</label>{" "}
              <input
                id="review-output"
                required
                inputMode="numeric"
                value={outputRate}
                onChange={(event) => setOutputRate(event.target.value)}
              />
            </p>
          </>
        ) : (
          <p>
            <label htmlFor="review-fx">Konservativer EUR-Betrag je 1 USD</label>{" "}
            <input
              id="review-fx"
              required
              inputMode="decimal"
              placeholder="1.150000000"
              value={fxRate}
              onChange={(event) => setFxRate(event.target.value)}
            />
          </p>
        )}
        <p>
          <label htmlFor="review-expiration">Gültig bis (lokale Zeit)</label>{" "}
          <input
            id="review-expiration"
            type="datetime-local"
            required
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="review-source">Geprüfte HTTPS-Quelle</label>{" "}
          <input
            id="review-source"
            type="url"
            required
            maxLength={512}
            placeholder="https://…"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Prüfe…" : "Versioniert speichern"}
        </button>
        {result ? <p role="status">{result}</p> : null}
      </form>
      <p>Kein Button hier erteilt eine Budget- oder Anbieterfreigabe.</p>
    </section>
  );
}
