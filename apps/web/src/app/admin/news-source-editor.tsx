"use client";

import { useState, type FormEvent } from "react";

export type SourceStatus = "pending" | "approved" | "blocked";
export interface EditableNewsSource {
  id: string;
  baseUrl: string;
  feedUrl?: string;
  access: "rss" | "atom" | "official_api" | "html";
  intervalMinutes: number;
  termsUrl: string;
  usage: "metadata_only" | "reviewed_excerpt";
  licenseNotes: string;
  status: SourceStatus;
  reviewedAt: string;
}
type SourceDraft = Omit<EditableNewsSource, "status" | "reviewedAt">;
export type SourceEditorCommand =
  | { action: "create_pending" | "replace_pending"; expectedRevision: number; source: SourceDraft }
  | { action: "approve" | "block" | "reopen"; expectedRevision: number; sourceId: string };

const INITIAL: SourceDraft = {
  id: "",
  baseUrl: "",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "",
  usage: "metadata_only",
  licenseNotes: "",
};

/**
 * Dormant Admin UI. All publishers/URLs are operator input; no fetch or
 * embedded providers. Actual write callback remains deliberately unwired.
 */
export default function NewsSourceEditor({
  sources,
  revision,
  ready = false,
  onCommand,
}: {
  sources: readonly EditableNewsSource[];
  revision: number;
  ready?: boolean;
  onCommand: (command: SourceEditorCommand) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<SourceDraft>(INITIAL);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!ready) {
    return (
      <p role="status">
        Nachrichtenquellen-Verwaltung noch nicht freigeschaltet. Keine Zugangsdaten oder
        Anbieter-URLs eingeben.
      </p>
    );
  }

  async function submit(command: SourceEditorCommand) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const saved = await onCommand(command);
      setMessage(
        saved
          ? "Änderung gespeichert. Quellenabrufe bleiben bis zur Betriebsfreigabe deaktiviert."
          : "Änderung nicht bestätigt. Quellenregister neu laden.",
      );
      if (saved) {
        setDraft(INITIAL);
        setEditing(false);
      }
    } catch {
      setMessage("Änderung nicht bestätigt. Quellenregister neu laden.");
    } finally {
      setBusy(false);
    }
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.id || !draft.baseUrl || !draft.termsUrl || draft.licenseNotes.trim().length < 12) {
      setMessage("Bitte Pflichtfelder und Lizenzhinweise vollständig ausfüllen.");
      return;
    }
    const source = { ...draft };
    if (!source.feedUrl) delete source.feedUrl;
    void submit({
      action: editing ? "replace_pending" : "create_pending",
      expectedRevision: revision,
      source,
    });
  }

  function edit(source: EditableNewsSource) {
    if (busy) return;
    const { status, reviewedAt, ...value } = source;
    void status;
    void reviewedAt;
    setDraft(value);
    setEditing(true);
    setMessage("");
  }

  return (
    <section aria-label="Nachrichtenquellen verwalten" className="admin-source-editor">
      <p role="status">
        Neue oder bearbeitete Quellen bleiben zunächst ungeprüft. Freigabe und Sperrung erfolgen
        ausdrücklich durch einen persönlichen Administrator.
      </p>
      <ul>
        {sources.map((source) => (
          <li key={source.id}>
            <strong>{source.id}</strong> ({source.status}) – {source.baseUrl}
            <button type="button" disabled={busy} onClick={() => edit(source)}>
              Bearbeiten
            </button>
            {source.status === "pending" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void submit({
                    action: "approve",
                    sourceId: source.id,
                    expectedRevision: revision,
                  })
                }
              >
                Nach Rechteprüfung freigeben
              </button>
            ) : null}
            {source.status !== "blocked" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void submit({
                    action: "block",
                    sourceId: source.id,
                    expectedRevision: revision,
                  })
                }
              >
                Sperren
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void submit({
                    action: "reopen",
                    sourceId: source.id,
                    expectedRevision: revision,
                  })
                }
              >
                Erneut prüfen
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="admin-form" onSubmit={saveDraft}>
        <h3>{editing ? "Quellendaten ändern (erneute Prüfung nötig)" : "Quelle hinzufügen"}</h3>
        <label htmlFor="news-source-id">Quellenkennung</label>
        <input
          id="news-source-id"
          value={draft.id}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          required
          pattern="[a-z][a-z0-9_-]{2,40}"
          disabled={busy || editing}
          maxLength={41}
        />
        <label htmlFor="news-source-url">Artikelbereich (HTTPS, endet auf /)</label>
        <input
          id="news-source-url"
          type="url"
          value={draft.baseUrl}
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          required
          disabled={busy}
          maxLength={512}
          placeholder="https://quelle.example/news/"
        />
        <label htmlFor="news-source-feed-url">Exakte RSS-/Atom-Adresse (HTTPS, optional)</label>
        <input
          id="news-source-feed-url"
          type="url"
          value={draft.feedUrl ?? ""}
          onChange={(event) => setDraft({ ...draft, feedUrl: event.target.value || undefined })}
          disabled={busy}
          maxLength={512}
          placeholder="https://quelle.example/rss.xml"
        />
        <p>
          Ohne separate Feed-Adresse wird der Artikelbereich selbst abgefragt. Beide URLs müssen auf
          demselben persönlich freigegebenen Host liegen.
        </p>
        <label htmlFor="news-source-access">Zugriffsart</label>
        <select
          id="news-source-access"
          value={draft.access}
          onChange={(event) =>
            setDraft({ ...draft, access: event.target.value as SourceDraft["access"] })
          }
          disabled={busy}
        >
          <option value="rss">RSS</option>
          <option value="atom">Atom</option>
          <option value="official_api">Offizielle API</option>
          <option value="html">HTML (nur nach Prüfung)</option>
        </select>
        <label htmlFor="news-source-interval">Mindestabstand (Minuten)</label>
        <input
          id="news-source-interval"
          type="number"
          min={15}
          max={10080}
          step={1}
          value={draft.intervalMinutes}
          onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
          required
          disabled={busy}
        />
        <label htmlFor="news-source-terms">Nutzungsbedingungen (HTTPS)</label>
        <input
          id="news-source-terms"
          type="url"
          value={draft.termsUrl}
          onChange={(event) => setDraft({ ...draft, termsUrl: event.target.value })}
          required
          disabled={busy}
          maxLength={512}
        />
        <label htmlFor="news-source-usage">Erlaubte Datennutzung</label>
        <select
          id="news-source-usage"
          value={draft.usage}
          onChange={(event) =>
            setDraft({ ...draft, usage: event.target.value as SourceDraft["usage"] })
          }
          disabled={busy}
        >
          <option value="metadata_only">Nur Metadaten</option>
          <option value="reviewed_excerpt">Geprüfte Auszüge</option>
        </select>
        <label htmlFor="news-source-license">Lizenz-/Attributionshinweise</label>
        <textarea
          id="news-source-license"
          value={draft.licenseNotes}
          onChange={(event) => setDraft({ ...draft, licenseNotes: event.target.value })}
          minLength={12}
          maxLength={300}
          required
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          {editing ? "Änderung als ungeprüft speichern" : "Quelle ungeprüft anlegen"}
        </button>
      </form>
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}
