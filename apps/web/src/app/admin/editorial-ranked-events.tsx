"use client";

import { useEffect, useState } from "react";
import { isRankedFeedCandidate } from "../../lib/admin-editorial-proxy";

interface RankedCandidate {
  eventId: string;
  profileId: string;
  profileRevision: number;
  headline: string;
  score: number;
  articleCount: number;
  sourceCount: number;
  reasons: string[];
  rankedAt: string;
  approvedForPublication: false;
}

export function parseRankedCandidatePage(value: unknown): readonly RankedCandidate[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !== "candidates,metadataOnly" ||
    data.metadataOnly !== true ||
    !Array.isArray(data.candidates) ||
    data.candidates.length > 25 ||
    !data.candidates.every(isRankedFeedCandidate)
  ) return null;
  return data.candidates as RankedCandidate[];
}

export default function EditorialRankedEvents({ enabled }: { enabled: boolean }) {
  const [candidates, setCandidates] = useState<readonly RankedCandidate[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/editorial-ranked-events?limit=25", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error("Rankings unavailable");
      const parsed = parseRankedCandidatePage((await response.json()) as unknown);
      if (!parsed) throw new Error("Rankings malformed");
      if (!signal?.aborted) setCandidates(parsed);
    } catch {
      if (!signal?.aborted) {
        setCandidates([]);
        setError("Gespeicherte Nachrichtenrankings konnten nicht geladen werden.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled]);

  return (
    <section className="jobs-section" aria-labelledby="ranked-events-heading">
      <h2 id="ranked-events-heading">Nachrichtenranking (gespeicherte Kandidaten)</h2>
      <p>
        Nur Metadaten aus einem freigegebenen Projektionslauf; keine bestätigten
        Fakten, keine unabhängige Quellenprüfung und keine Veröffentlichungsfreigabe.
        Die Ergebnisse zeigen einen historischen Snapshot, keinen Live-Feed.
      </p>
      {!enabled ? <p role="status">Rankingansicht nicht freigeschaltet.</p> : null}
      {enabled ? (
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Lade Ranking …" : "Ranking aktualisieren"}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {enabled && !loading && !error && candidates.length === 0 ? (
        <p>Noch keine persistierten Rankingkandidaten vorhanden.</p>
      ) : null}
      {enabled && candidates.length > 0 && !error ? (
        <ol>
          {candidates.map((candidate) => (
            <li key={candidate.profileId + ":" + candidate.profileRevision + ":" + candidate.eventId}>
              <strong>{candidate.headline}</strong>
              <p>
                Profil {candidate.profileId} (Revision {candidate.profileRevision}) · Score{" "}
                {candidate.score} · {candidate.sourceCount} verschiedene Quellen-IDs ·{" "}
                {candidate.articleCount} Artikel
              </p>
              <p>Prüfstatus: Kandidat – unabhängige Verifikation erforderlich.</p>
              <p>Erfasst: <time dateTime={candidate.rankedAt}>{candidate.rankedAt}</time></p>
              <p>Gründe: {candidate.reasons.join(", ")}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
