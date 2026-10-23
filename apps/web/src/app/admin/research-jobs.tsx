"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ResearchJobOverview } from "../../lib/admin-jobs-list";
import { isResearchJobOverview } from "../../lib/admin-jobs-list";

const statusNames: Record<ResearchJobOverview["status"], string> = {
  pending: "Vorgemerkt",
  running: "In Bearbeitung",
  retry: "Erneuter Versuch",
  done: "Abgeschlossen",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
};

const deliveryNames: Record<ResearchJobOverview["deliveryState"], string> = {
  pending: "Noch nicht an Queue zugestellt",
  enqueued: "An Queue zugestellt",
};

function isJobsResponse(data: unknown): data is { jobs: ResearchJobOverview[] } {
  return (
    typeof data === "object" &&
    data !== null &&
    "jobs" in data &&
    Array.isArray(data.jobs) &&
    data.jobs.length <= 20 &&
    data.jobs.every(isResearchJobOverview)
  );
}

export default function ResearchJobs({ enabled }: { enabled: boolean }) {
  const [jobs, setJobs] = useState<ResearchJobOverview[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState("");
  const topicForRetry = useRef<string | null>(null);
  const [listError, setListError] = useState("");
  const [submission, setSubmission] = useState("");
  const pendingKey = useRef<string | null>(null);

  async function loadJobs() {
    setRefreshing(true);
    setListError("");
    try {
      const response = await fetch("/api/admin/jobs", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setJobs([]);
        setListError("Deine Admin-Sitzung ist abgelaufen. Bitte erneut anmelden.");
        return;
      }
      if (!response.ok) throw new Error("Unable to load jobs");
      const body: unknown = await response.json();
      if (!isJobsResponse(body)) throw new Error("Invalid jobs response");
      setJobs(body.jobs);
    } catch {
      setListError("Aufträge konnten nicht geladen werden. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (enabled) void loadJobs();
    // Mounted for the lifetime of the guarded admin dashboard.
  }, [enabled]);

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || busy) return;
    const normalizedTopic = topic.trim();
    const size = Array.from(normalizedTopic).length;
    if (size < 12 || size > 160 || /[\u0000-\u001f\u007f]/.test(normalizedTopic)) {
      setSubmission("Bitte ein Thema mit 12 bis 160 Zeichen ohne Zeilenumbrüche eingeben.");
      return;
    }
    // A retry must preserve both its key AND the associated topic.
    if (pendingKey.current && topicForRetry.current !== normalizedTopic) {
      pendingKey.current = null;
      topicForRetry.current = null;
    }
    setBusy(true);
    setSubmission("");
    try {
      // Keep the same key across network errors; retries must not create new jobs.
      if (!pendingKey.current) {
        pendingKey.current = crypto.randomUUID();
        topicForRetry.current = normalizedTopic;
      }
      const response = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          kind: "research",
          idempotencyKey: pendingKey.current,
          topic: topicForRetry.current,
        }),
      });
      if (response.status === 202) {
        const data: unknown = await response.json();
        if (
          typeof data !== "object" ||
          data === null ||
          !("accepted" in data) ||
          data.accepted !== true ||
          !("jobId" in data) ||
          typeof data.jobId !== "string" ||
          !/^[0-9a-f-]{36}$/.test(data.jobId)
        )
          throw new Error("Invalid confirmation");
        pendingKey.current = null;
        topicForRetry.current = null;
        setTopic("");
        setSubmission("Auftrag in PostgreSQL vorgemerkt. Eine Recherche wurde nicht gestartet.");
        await loadJobs();
      } else if (response.status === 401) {
        setSubmission("Deine Admin-Sitzung ist abgelaufen. Bitte erneut anmelden.");
      } else if (response.status === 409) {
        // New user action may choose a fresh idempotency key.
        pendingKey.current = null;
        topicForRetry.current = null;
        setSubmission("Diese Anfrage widerspricht einer früheren Vormerkung.");
      } else if (response.status === 400) {
        pendingKey.current = null;
        topicForRetry.current = null;
        setSubmission("Ungültige Anfrage. Bitte erneut versuchen.");
      } else {
        setSubmission(
          "Vormerkung nicht bestätigt. Erneut versuchen verwendet dieselbe Anfragekennung.",
        );
      }
    } catch {
      setSubmission(
        "Verbindung unterbrochen. Ein erneuter Versuch verwendet dieselbe Anfragekennung.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="jobs-title">
      <h2 id="jobs-title">Rechercheaufträge</h2>
      <p>
        Diese Übersicht zeigt ausschließlich PostgreSQL-Vormerkungen und deren Queue-Zustellung. Sie
        ist keine Anzeige für eine laufende Recherche oder Videoerstellung.
      </p>
      {!enabled ? (
        <div className="notice" role="status">
          <strong>Noch nicht freigeschaltet.</strong> Auftragserstellung und Übersicht bleiben bis
          zur gesonderten Datenbankfreigabe deaktiviert. Der bestehende Admin-Zugang ist weiterhin
          nutzbar.
        </div>
      ) : (
        <>
          <form className="admin-form jobs-form" onSubmit={createJob}>
            <span className="jobs-field-label">Auftragsart: Recherche (nur Vormerkung)</span>
            <label htmlFor="research-topic">Recherchethema</label>
            <input
              id="research-topic"
              name="topic"
              type="text"
              required
              minLength={12}
              maxLength={160}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Zum Beispiel: Nachhaltige Stadtmobilität in Europa"
              autoComplete="off"
              disabled={busy}
            />
            <p className="jobs-hint">
              12–160 Zeichen. Das Thema wird nur gespeichert; eine tatsächliche Recherche
              oder Quellenprüfung wird damit noch nicht gestartet.
            </p>
            <button type="submit" disabled={busy}>
              {busy ? "Speichere Vormerkung …" : "Neuen Auftrag vormerken"}
            </button>
            {submission ? (
              <p role="status" aria-live="polite">
                {submission}
              </p>
            ) : null}
          </form>
          <div className="jobs-heading">
            <h3>Letzte 20 Aufträge</h3>
            <button
              type="button"
              className="jobs-refresh"
              onClick={() => void loadJobs()}
              disabled={refreshing || busy}
            >
              {refreshing ? "Aktualisiere …" : "Aktualisieren"}
            </button>
          </div>
          {listError ? <p role="alert">{listError}</p> : null}
          {loading ? <p role="status">Lade Vormerkungen …</p> : null}
          {!loading && !listError && jobs.length === 0 ? (
            <p>Noch keine Rechercheaufträge vorgemerkt.</p>
          ) : null}
          {jobs.length > 0 && !listError ? (
            <ul className="jobs-list">
              {jobs.map((job) => (
                <li className="jobs-entry" key={job.id}>
                  <div className="jobs-entry-top">
                    <strong>{statusNames[job.status]}</strong>
                    <time dateTime={job.createdAt}>
                      {new Intl.DateTimeFormat("de-DE", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(job.createdAt))}
                    </time>
                  </div>
                  <span>{deliveryNames[job.deliveryState]}</span>
                  <span>{job.topic ?? "Ohne Thema (älterer Auftrag)"}</span>
                  <code>{job.id}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
