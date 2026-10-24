"use client";

import { useState, type FormEvent } from "react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ReviewDecision = "verified" | "disputed" | "rejected";
type ReviewStatus = "candidate" | ReviewDecision;

export interface EvidenceCard {
  id: string;
  jobId: string;
  sourceUrl: string;
  publisher: string;
  headline: string;
  claim: string;
  status: ReviewStatus;
  reviewedAt: string | null;
}

const statusLabels: Record<ReviewStatus, string> = {
  candidate: "Ungeprüfter Quellenkandidat",
  verified: "Redaktionell bestätigt",
  disputed: "Redaktionell umstritten",
  rejected: "Redaktionell abgelehnt",
};

function validEvidence(value: unknown, jobId: string): value is EvidenceCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 8 &&
    typeof data.id === "string" &&
    UUID.test(data.id) &&
    data.jobId === jobId &&
    typeof data.sourceUrl === "string" &&
    data.sourceUrl.startsWith("https://") &&
    data.sourceUrl.length <= 512 &&
    typeof data.publisher === "string" &&
    data.publisher.length <= 120 &&
    typeof data.headline === "string" &&
    data.headline.length <= 200 &&
    typeof data.claim === "string" &&
    data.claim.length <= 280 &&
    ["candidate", "verified", "disputed", "rejected"].includes(data.status as string) &&
    (data.reviewedAt === null ||
      (typeof data.reviewedAt === "string" && !Number.isNaN(Date.parse(data.reviewedAt))))
  );
}

function ReviewItem({ item, onUpdated }: { item: EvidenceCard; onUpdated: () => Promise<void> }) {
  const [decision, setDecision] = useState<ReviewDecision | "">("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function review(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const reasonText = reason.trim();
    if (
      !decision ||
      !confirmed ||
      busy ||
      item.status !== "candidate" ||
      Array.from(reasonText).length < 20 ||
      Array.from(reasonText).length > 500 ||
      reasonText.split("").some((c) => {
        const code = c.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch("/api/admin/evidence/review", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidenceId: item.id, decision, reason: reasonText }),
      });
      if (response.status === 200) {
        setFeedback("Entscheidung einmalig gespeichert. Keine automatische Veröffentlichung.");
        await onUpdated();
      } else if (response.status === 409) {
        setFeedback("Dieser Nachweis wurde bereits bewertet. Liste bitte aktualisieren.");
        await onUpdated();
      } else if (response.status === 401) {
        setFeedback(
          "Prüfer-Sitzung fehlt oder ist abgelaufen. Bitte persönlichen Redakteur-Zugang überprüfen.",
        );
      } else {
        setFeedback(
          "Entscheidung nicht bestätigt. Vor erneutem Versuch bitte Liste aktualisieren.",
        );
      }
    } catch {
      setFeedback(
        "Verbindung unterbrochen. Bitte vor weiteren Änderungen die Liste aktualisieren.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="evidence-card">
      <strong>{item.headline}</strong>
      <span>{item.publisher}</span>
      <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
        Quelle in neuem Tab öffnen
      </a>
      <p>{item.claim}</p>
      <p>
        <strong>Prüfstatus:</strong> {statusLabels[item.status]}
      </p>
      {item.status === "candidate" ? (
        <form className="evidence-form" onSubmit={(event) => void review(event)}>
          <label htmlFor={"evidence-decision-" + item.id}>Redaktionelle Entscheidung</label>
          <select
            id={"evidence-decision-" + item.id}
            value={decision}
            disabled={busy}
            required
            onChange={(event) => setDecision(event.target.value as ReviewDecision | "")}
          >
            <option value="">Bitte Entscheidung auswählen</option>
            <option value="verified">Bestätigt</option>
            <option value="disputed">Umstritten</option>
            <option value="rejected">Abgelehnt</option>
          </select>
          <label htmlFor={"evidence-reason-" + item.id}>Prüfbegründung (20–500 Zeichen)</label>
          <textarea
            id={"evidence-reason-" + item.id}
            value={reason}
            minLength={20}
            maxLength={500}
            required
            rows={3}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Welche Textstelle der Originalquelle stützt oder widerspricht der Aussage?"
          />
          <label className="evidence-confirm">
            <input
              type="checkbox"
              required
              disabled={busy}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Ich habe diese Quelle und die konkrete Aussage selbst geprüft.
          </label>
          <button
            type="submit"
            disabled={!decision || !confirmed || busy || Array.from(reason.trim()).length < 20}
          >
            {busy ? "Speichere Entscheidung …" : "Entscheidung unwiderruflich speichern"}
          </button>
          {feedback ? <p role="status">{feedback}</p> : null}
        </form>
      ) : (
        <p>Dieser Prüfstatus kann hier nicht nachträglich überschrieben werden.</p>
      )}
    </li>
  );
}

export default function EvidenceReview({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<EvidenceCard[]>([]);
  const [error, setError] = useState("");

  async function load(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/evidence?jobId=" + encodeURIComponent(jobId), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setItems([]);
        setError("Admin-Sitzung abgelaufen. Bitte neu anmelden.");
        return;
      }
      if (!response.ok) throw new Error("Review list unavailable");
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("evidence" in result) ||
        !Array.isArray(result.evidence) ||
        result.evidence.length > 20 ||
        !result.evidence.every((value) => validEvidence(value, jobId))
      ) {
        throw new Error("Invalid review list");
      }
      setItems(result.evidence);
    } catch {
      setItems([]);
      setError("Quellen konnten nicht geladen werden. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!open) {
      setOpen(true);
      void load();
    } else {
      setOpen(false);
    }
  }

  return (
    <section className="evidence-section" aria-label="Quellen-Nachweise">
      <button className="jobs-refresh" type="button" onClick={toggle}>
        {open ? "Quellen schließen" : "Quellen und Prüfstatus anzeigen"}
      </button>
      {open ? (
        <div>
          <p className="jobs-hint">
            Ein Quellenlink beweist keine Aussage. Bitte Originaltext und Kontext selbst prüfen.
            Entscheidungen sind endgültig; sie veröffentlichen keine Inhalte.
          </p>
          <button
            className="jobs-refresh"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Lade Quellen …" : "Quellen aktualisieren"}
          </button>
          {error ? <p role="alert">{error}</p> : null}
          {!loading && !error && items.length === 0 ? (
            <p>Noch keine Quellen-Nachweise zu diesem Auftrag vorhanden.</p>
          ) : null}
          {items.length > 0 && !error ? (
            <ul className="evidence-list">
              {items.map((item) => (
                <ReviewItem key={item.id} item={item} onUpdated={load} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
