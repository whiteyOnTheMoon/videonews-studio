"use client";

import { useRef, useState, type FormEvent } from "react";

type Kind = "source" | "claim" | "claim_rejected" | "review" | "script_revision" | "decision";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** Admin-only audit recording. No claim certification or publication action. */
export default function EditorialTimelineEntry({ enabled }: { enabled: boolean }) {
  const [storyId, setStoryId] = useState("");
  const [kind, setKind] = useState<Kind>("source");
  const [referenceUri, setReferenceUri] = useState("");
  const [documentSha256, setDocumentSha256] = useState("");
  const [summary, setSummary] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const locked = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || locked.current) return;
    const reasonCodes = reasonText.split(",").map((value) => value.trim());
    if (
      !UUID.test(storyId) ||
      summary.length < 8 ||
      summary.length > 2000 ||
      [...summary].some((char) => char.charCodeAt(0) < 32) ||
      reasonCodes.length < 1 ||
      reasonCodes.length > 20 ||
      reasonCodes.some((code) => !CODE.test(code)) ||
      (documentSha256.length > 0 && !SHA.test(documentSha256))
    ) {
      setError("Story-ID, Zusammenfassung, Gründe und Artefakt-SHA-256 prüfen.");
      return;
    }
    const reference = referenceUri.trim();
    if (reference) {
      try {
        const uri = new URL(reference);
        if (
          uri.protocol !== "https:" ||
          uri.username ||
          uri.password ||
          uri.search ||
          uri.hash ||
          !/^https:\/\/[a-z0-9.-]+(?::443)?\/[a-zA-Z0-9/._~-]*$/.test(reference)
        )
          throw new Error("Source must be canonical HTTPS");
      } catch {
        setError("Nur kanonische öffentliche HTTPS-Referenzen.");
        return;
      }
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/editorial-timeline", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyId,
          eventKind: kind,
          referenceUri: reference || null,
          documentSha256: documentSha256 || null,
          details: { summary, reasonCodes },
        }),
      });
      if (response.status !== 200) throw new Error("Redaktionsereignis nicht gespeichert.");
      const raw: unknown = await response.json();
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).eventId !== "string" ||
        !UUID.test((raw as Record<string, string>).eventId ?? "") ||
        (raw as Record<string, unknown>).approvedForPublication !== false
      )
        throw new Error("Redaktionsereignis nicht bestätigt.");
      setNotice("Redaktionsereignis revisionssicher angehängt. Keine Veröffentlichungsfreigabe.");
    } catch {
      setError("Redaktionsereignis konnte nicht gespeichert werden.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="p2-timeline-write-heading">
      <h2 id="p2-timeline-write-heading">Redaktionelles Story-Protokoll</h2>
      <p>
        Quellen, Entscheidungen, abgelehnte Aussagen und Skriptrevisionen einer Story zuordnen.
        Keine automatische Freigabe.
      </p>
      {!enabled ? <p role="status">Story-Protokoll nicht freigeschaltet.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {enabled ? (
        <form onSubmit={submit}>
          <label htmlFor="timeline-story-id">Story-UUID</label>
          <input
            id="timeline-story-id"
            required
            value={storyId}
            onChange={(event) => setStoryId(event.target.value)}
          />
          <label htmlFor="timeline-kind">Art des Eintrags</label>
          <select
            id="timeline-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            <option value="source">Quelle</option>
            <option value="claim">Aussage</option>
            <option value="claim_rejected">Abgelehnte Aussage</option>
            <option value="review">Redaktionelle Prüfung</option>
            <option value="script_revision">Skriptrevision</option>
            <option value="decision">Entscheidung</option>
          </select>
          <label htmlFor="timeline-reference">Öffentlicher HTTPS-Beleg (optional)</label>
          <input
            id="timeline-reference"
            value={referenceUri}
            onChange={(event) => setReferenceUri(event.target.value)}
          />
          <label htmlFor="timeline-document-sha">Dokument-SHA-256 (optional)</label>
          <input
            id="timeline-document-sha"
            value={documentSha256}
            onChange={(event) => setDocumentSha256(event.target.value)}
          />
          <label htmlFor="timeline-summary">Redaktionelle Begründung</label>
          <textarea
            id="timeline-summary"
            required
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <label htmlFor="timeline-reasons">Entscheidungs-Codes (kommagetrennt)</label>
          <input
            id="timeline-reasons"
            required
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            Story-Ereignis speichern
          </button>
        </form>
      ) : null}
    </section>
  );
}
