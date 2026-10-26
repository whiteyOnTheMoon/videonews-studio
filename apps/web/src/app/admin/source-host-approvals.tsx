"use client";

import { useEffect, useRef, useState } from "react";
import { parseHostApprovalView, type HostApprovalView } from "../../lib/admin-source-hosts-proxy";
import { parseSourceViewSnapshot, type SourceViewSnapshot } from "./news-sources";

interface ReviewState {
  sources: SourceViewSnapshot;
  hosts: HostApprovalView;
}
export interface ReviewChoice {
  host: string;
  action: "grant" | "revoke";
}
export function reviewableHostChoices(state: ReviewState): ReviewChoice[] {
  const approved = new Set<string>();
  for (const source of state.sources.sources) {
    if (source.status !== "approved") continue;
    try {
      const url = new URL(source.baseUrl);
      if (url.protocol === "https:") approved.add(url.hostname);
    } catch {
      // Invalid metadata must not grant a host.
    }
  }
  const existing = new Set(state.hosts.approvedHosts);
  return [...new Set([...approved, ...existing])]
    .sort()
    .map((host) => ({ host, action: existing.has(host) ? "revoke" : "grant" }));
}
async function loadReview(signal?: AbortSignal): Promise<ReviewState> {
  const options: RequestInit = {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
  };
  const [sourcesResponse, hostsResponse] = await Promise.all([
    fetch("/api/admin/news-sources", options),
    fetch("/api/admin/source-hosts", options),
  ]);
  if (sourcesResponse.status !== 200 || hostsResponse.status !== 200) {
    throw new Error("Host review unavailable");
  }
  const sources = parseSourceViewSnapshot((await sourcesResponse.json()) as unknown);
  const hosts = parseHostApprovalView((await hostsResponse.json()) as unknown);
  if (!sources || !hosts) throw new Error("Host review invalid");
  return { sources, hosts };
}
function validSave(value: unknown, revision: number, host: string, action: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 5 &&
    ["saved", "host", "action", "revision", "feedActive"].every((key) => Object.hasOwn(row, key)) &&
    row.saved === true &&
    row.host === host &&
    row.action === action &&
    row.revision === revision + 1 &&
    row.feedActive === false
  );
}

export default function SourceHostApprovals({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [host, setHost] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadReview(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState(null);
          setError("Host-Freigaben nicht verfügbar. Persönliche Admin-Anmeldung prüfen.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled]);
  const choices = state ? reviewableHostChoices(state) : [];
  const choice = choices.find((candidate) => candidate.host === host);
  const validReason =
    reason.length >= 20 &&
    reason.length <= 300 &&
    reason.trim() === reason &&
    ![...reason].some((letter) => letter.charCodeAt(0) < 32);
  async function submit() {
    if (
      !enabled ||
      !state ||
      !choice ||
      !validReason ||
      locked.current ||
      state.sources.revision < 1
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const expected = state.hosts.revision;
    try {
      const response = await fetch("/api/admin/source-hosts", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: choice.action,
          expectedRevision: expected,
          expectedSourceRevision: state.sources.revision,
          host: choice.host,
          reason,
        }),
      });
      if (
        response.status !== 200 ||
        !validSave((await response.json()) as unknown, expected, choice.host, choice.action)
      ) {
        throw new Error("Host approval unconfirmed");
      }
      const fresh = await loadReview();
      if (
        fresh.hosts.revision !== expected + 1 ||
        fresh.sources.revision !== state.sources.revision ||
        fresh.hosts.approvedHosts.includes(choice.host) !== (choice.action === "grant")
      ) {
        throw new Error("Unexpected host approval revision");
      }
      setState(fresh);
      setHost("");
      setReason("");
      setNotice("Entscheidung protokolliert. Keine Nachrichtenabrufe gestartet.");
    } catch {
      // Uncertain outcome: never replay a host grant/revoke automatically.
      setState(null);
      setHost("");
      setReason("");
      setError("Änderung nicht bestätigt. Seite neu laden und Host-Freigabe erneut prüfen.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="jobs-section" aria-labelledby="source-host-title">
      <h2 id="source-host-title">Separate Host-Freigaben</h2>
      <p>
        Netzwerkberechtigungen benötigen eine eigene Prüfung der Nutzungsrechte und eine
        dokumentierte Entscheidung. Eine Freigabe startet keine Feeds.
      </p>
      {!enabled ? <p role="status">Host-Freigaben sind noch nicht aktiviert.</p> : null}
      {enabled && loading ? <p role="status">Lade geschützte Host-Freigaben …</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {enabled && !loading && state ? (
        <>
          <p>
            Quellenrevision: {state.sources.revision}; Hostrevision: {state.hosts.revision}
          </p>
          <p>Freigegebene Hosts: {state.hosts.approvedHosts.join(", ") || "keine"}</p>
          {choices.length === 0 ? (
            <p role="status">Keine geprüften Quellen oder bestehenden Host-Freigaben vorhanden.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor="source-host-choice">Hostname auswählen</label>
              <select
                id="source-host-choice"
                value={host}
                disabled={busy}
                required
                onChange={(event) => setHost(event.target.value)}
              >
                <option value="">Host auswählen</option>
                {choices.map((item) => (
                  <option value={item.host} key={item.host}>
                    {item.host} – {item.action === "revoke" ? "widerrufen" : "freigeben"}
                  </option>
                ))}
              </select>
              <label htmlFor="source-host-reason">Begründung der unabhängigen Prüfung</label>
              <textarea
                id="source-host-reason"
                value={reason}
                rows={3}
                minLength={20}
                maxLength={300}
                disabled={busy}
                required
                onChange={(event) => setReason(event.target.value)}
              />
              <button type="submit" disabled={busy || !choice || !validReason}>
                {choice?.action === "revoke" ? "Freigabe widerrufen" : "Host separat freigeben"}
              </button>
            </form>
          )}
        </>
      ) : null}
    </section>
  );
}
