"use client";

import { useRef, useState, type FormEvent } from "react";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{1,39}$/;
type Stage = "ranking" | "claim_review" | "freshness" | "script_revision" | "quality";
type Outcome = "candidate" | "blocked" | "needs_review";

/**
 * Manual named-person checkpoint entry; each write goes through same-origin BFF,
 * personal editor auth, verified PostgreSQL session_user and append-only DB CAS.
 * This form cannot verify claims, fabricate an artifact or authorize publishing.
 */
export default function EditorialCheckpointEntry({ enabled }: { enabled: boolean }) {
  const [eventId, setEventId] = useState("");
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [stage, setStage] = useState<Stage>("ranking");
  const [outcome, setOutcome] = useState<Outcome>("needs_review");
  const [artifactSha256, setArtifactSha256] = useState("");
  const [reasonCodesText, setReasonCodesText] = useState("");
  const [scoreText, setScoreText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || locked.current) return;
    const reasonCodes = reasonCodesText.split(",").map((code) => code.trim());
    const score = scoreText === "" ? null : Number(scoreText);
    if (
      !UUID.test(eventId) ||
      !DIGEST.test(artifactSha256) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > 9999 ||
      reasonCodes.length < 1 ||
      reasonCodes.length > 20 ||
      reasonCodes.some((code) => !CODE.test(code)) ||
      (score !== null && (!Number.isSafeInteger(score) || score < 0 || score > 1000))
    ) {
      setError("Ereignis, Revision, SHA-256, Prüfgründe und Score prüfen.");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/editorial-checkpoints", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          expectedRevision,
          stage,
          outcome,
          artifactSha256,
          reasonCodes,
          score,
        }),
      });
      if (response.status === 409) throw new Error("Revision veraltet: bitte Verlauf neu prüfen.");
      if (response.status !== 200) throw new Error("Checkpoint nicht bestätigt.");
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        (result as Record<string, unknown>).saved !== true ||
        (result as Record<string, unknown>).revision !== expectedRevision + 1 ||
        (result as Record<string, unknown>).approvedForPublication !== false
      )
        throw new Error("Checkpoint-Antwort nicht vertrauenswürdig.");
      setExpectedRevision(expectedRevision + 1);
      setNotice("Checkpoint revisionsgesichert. Keine Veröffentlichungsfreigabe.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkpoint nicht bestätigt.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="checkpoint-write-heading">
      <h2 id="checkpoint-write-heading">Redaktionelle Prüfentscheidung</h2>
      <p>
        Ranking, Claims, Aktualität, Skriptrevision und Qualität persönlich und revisionssicher
        festhalten. Diese Eingabe veröffentlicht nichts.
      </p>
      {!enabled ? <p role="status">Prüfprotokoll nicht freigeschaltet.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {enabled ? (
        <form onSubmit={submit}>
          <label htmlFor="checkpoint-event-id">Ereignis-UUID</label>
          <input
            id="checkpoint-event-id"
            required
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
          />
          <label htmlFor="checkpoint-revision">Erwartete letzte Revision (CAS)</label>
          <input
            id="checkpoint-revision"
            type="number"
            min={0}
            max={9999}
            required
            value={expectedRevision}
            onChange={(event) => setExpectedRevision(Number(event.target.value))}
          />
          <label htmlFor="checkpoint-stage">Prüfschritt</label>
          <select
            id="checkpoint-stage"
            value={stage}
            onChange={(event) => setStage(event.target.value as Stage)}
          >
            <option value="ranking">Ranking</option>
            <option value="claim_review">Claim-Prüfung</option>
            <option value="freshness">Aktualität</option>
            <option value="script_revision">Skriptrevision</option>
            <option value="quality">Qualität / unabhängige Prüfung</option>
          </select>
          <label htmlFor="checkpoint-outcome">Ergebnis</label>
          <select
            id="checkpoint-outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as Outcome)}
          >
            <option value="candidate">Kandidat</option>
            <option value="needs_review">Nachprüfung</option>
            <option value="blocked">Gesperrt</option>
          </select>
          <label htmlFor="checkpoint-digest">SHA-256 des geprüften Artefakts</label>
          <input
            id="checkpoint-digest"
            required
            minLength={64}
            maxLength={64}
            value={artifactSha256}
            onChange={(event) => setArtifactSha256(event.target.value)}
          />
          <label htmlFor="checkpoint-reasons">Grundcodes (kommagetrennt)</label>
          <input
            id="checkpoint-reasons"
            required
            value={reasonCodesText}
            onChange={(event) => setReasonCodesText(event.target.value)}
          />
          <label htmlFor="checkpoint-score">Score (0–1000, optional)</label>
          <input
            id="checkpoint-score"
            type="number"
            min={0}
            max={1000}
            value={scoreText}
            onChange={(event) => setScoreText(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            Prüfentscheidung speichern
          </button>
        </form>
      ) : null}
    </section>
  );
}
