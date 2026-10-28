"use client";

import { useState, type FormEvent } from "react";

type Attempt = Readonly<{ idempotencyKey: string; requestId: string }>;

function newAttempt(): Attempt {
  return {
    idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
    requestId: crypto.randomUUID().replaceAll("-", ""),
  };
}

/** Records an encrypted pending SQL intent only. No provider dispatch or budget change. */
export default function AiProviderJobs({ enabled }: { enabled: boolean }) {
  const [provider, setProvider] = useState<"openai" | "google_gemini">("openai");
  const [model, setModel] = useState("");
  const [priceSnapshotId, setPriceSnapshotId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxInput, setMaxInput] = useState("4096");
  const [maxOutput, setMaxOutput] = useState("256");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  if (!enabled) return null;

  function edit(update: () => void) {
    update();
    setAttempt(null);
    setResult("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const ids = attempt ?? newAttempt();
    setAttempt(ids);
    setBusy(true);
    setResult("");
    try {
      const response = await fetch("/api/admin/ai-provider-jobs", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ids,
          provider,
          model: model.trim(),
          priceSnapshotId: priceSnapshotId.trim().toLowerCase(),
          prompt,
          maxInputTokens: Number(maxInput),
          maxOutputTokens: Number(maxOutput),
        }),
      });
      if (response.status !== 202) throw new Error("rejected");
      const receipt: unknown = await response.json();
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("accepted" in receipt) ||
        receipt.accepted !== true ||
        !("active" in receipt) ||
        receipt.active !== false ||
        !("enqueued" in receipt) ||
        receipt.enqueued !== false ||
        !("jobId" in receipt) ||
        typeof receipt.jobId !== "string"
      ) {
        throw new Error("receipt");
      }
      setResult(
        "Auftrag ausschließlich als ausstehender SQL-Eintrag gespeichert: " + receipt.jobId,
      );
    } catch {
      setResult("Auftrag nicht bestätigt. Du kannst mit derselben Vorgangskennung erneut prüfen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="ai-job-submission-title">
      <h2 id="ai-job-submission-title">KI-Auftrag vormerken</h2>
      <p>
        Persönliche Freigabe eines verschlüsselten, ausstehenden SQL-Auftrags. Keine
        Redis-Zustellung, keine Anbieteranfrage und keine Budgetfreigabe.
      </p>
      <form className="jobs-form evidence-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="provider-job-provider">Anbieter</label>
        <select
          id="provider-job-provider"
          value={provider}
          disabled={busy}
          onChange={(event) =>
            edit(() => setProvider(event.target.value as "openai" | "google_gemini"))
          }
        >
          <option value="openai">OpenAI</option>
          <option value="google_gemini">Google Gemini</option>
        </select>
        <label htmlFor="provider-job-model">Geprüfte Modellkennung</label>
        <input
          id="provider-job-model"
          required
          maxLength={80}
          value={model}
          disabled={busy}
          onChange={(event) => edit(() => setModel(event.target.value))}
        />
        <label htmlFor="provider-job-price">Persönlich geprüfte Preis-Snapshot-UUID</label>
        <input
          id="provider-job-price"
          required
          maxLength={36}
          value={priceSnapshotId}
          disabled={busy}
          onChange={(event) => edit(() => setPriceSnapshotId(event.target.value))}
        />
        <label htmlFor="provider-job-prompt">Textprompt (max. 32 KiB)</label>
        <textarea
          id="provider-job-prompt"
          required
          maxLength={32768}
          value={prompt}
          disabled={busy}
          onChange={(event) => edit(() => setPrompt(event.target.value))}
        />
        <label htmlFor="provider-job-max-input">Eingabeobergrenze</label>
        <input
          id="provider-job-max-input"
          type="number"
          required
          min={1}
          max={32768}
          value={maxInput}
          disabled={busy}
          onChange={(event) => edit(() => setMaxInput(event.target.value))}
        />
        <label htmlFor="provider-job-max-output">Ausgabeobergrenze</label>
        <input
          id="provider-job-max-output"
          type="number"
          required
          min={16}
          max={4096}
          value={maxOutput}
          disabled={busy}
          onChange={(event) => edit(() => setMaxOutput(event.target.value))}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Prüfe und speichere …" : "Verschlüsselten SQL-Auftrag vormerken"}
        </button>
        {result ? <p role="status">{result}</p> : null}
      </form>
    </section>
  );
}
