"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NewsSourceEditor, {
  type EditableNewsSource,
  type SourceEditorCommand,
} from "./news-source-editor";

export interface SourceViewSnapshot {
  revision: number;
  sources: EditableNewsSource[];
}
const FIELDS = [
  "id",
  "baseUrl",
  "access",
  "intervalMinutes",
  "termsUrl",
  "usage",
  "licenseNotes",
  "status",
  "reviewedAt",
];
const SOURCE_ID = /^[a-z][a-z0-9_-]{2,40}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pure UI boundary: only display the complete, already-sanitized BFF snapshot.
 * This is not a substitute for independently enforced backend validation.
 */
export function parseSourceViewSnapshot(value: unknown): SourceViewSnapshot | null {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "revision") ||
    !Object.hasOwn(value, "sources") ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20
  ) {
    return null;
  }
  const names = new Set<string>();
  const urls = new Set<string>();
  const sources: EditableNewsSource[] = [];
  for (const entry of value.sources as unknown[]) {
    if (
      !object(entry) ||
      Object.keys(entry).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(entry, field)) ||
      typeof entry.id !== "string" ||
      !SOURCE_ID.test(entry.id) ||
      typeof entry.baseUrl !== "string" ||
      !entry.baseUrl.startsWith("https://") ||
      typeof entry.termsUrl !== "string" ||
      !entry.termsUrl.startsWith("https://") ||
      !["rss", "atom", "official_api", "html"].includes(entry.access as string) ||
      !Number.isSafeInteger(entry.intervalMinutes) ||
      (entry.intervalMinutes as number) < 15 ||
      (entry.intervalMinutes as number) > 10080 ||
      !["metadata_only", "reviewed_excerpt"].includes(entry.usage as string) ||
      typeof entry.licenseNotes !== "string" ||
      entry.licenseNotes.length < 12 ||
      entry.licenseNotes.length > 300 ||
      !["pending", "approved", "blocked"].includes(entry.status as string) ||
      typeof entry.reviewedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt) ||
      names.has(entry.id) ||
      urls.has(entry.baseUrl)
    ) {
      return null;
    }
    names.add(entry.id);
    urls.add(entry.baseUrl);
    sources.push(entry as unknown as EditableNewsSource);
  }
  return { revision: value.revision as number, sources };
}

async function loadSnapshot(signal?: AbortSignal): Promise<SourceViewSnapshot> {
  const response = await fetch("/api/admin/news-sources", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (response.status !== 200) throw new Error("Source registry not authorized or unavailable");
  const snapshot = parseSourceViewSnapshot((await response.json()) as unknown);
  if (!snapshot) throw new Error("Invalid source registry response");
  return snapshot;
}

function validSave(value: unknown, command: SourceEditorCommand): boolean {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !["saved", "revision", "sourceId", "status", "feedActive"].every((field) =>
      Object.hasOwn(value, field),
    )
  )
    return false;
  const id = "source" in command ? command.source.id : command.sourceId;
  const status =
    command.action === "approve"
      ? "approved"
      : command.action === "block"
        ? "blocked"
        : "pending";
  return (
    value.saved === true &&
    value.feedActive === false &&
    value.revision === command.expectedRevision + 1 &&
    value.sourceId === id &&
    value.status === status
  );
}

/**
 * Mounted only as a default-off Admin preview. The API process itself never
 * mounts the source registry; activating this UI flag alone cannot start feeds.
 */
export default function NewsSources({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<SourceViewSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    void loadSnapshot(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSnapshot(value);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setError("Quellenregister nicht verfügbar. Persönliche Admin-Sitzung prüfen.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled]);

  const onCommand = useCallback(
    async (command: SourceEditorCommand): Promise<boolean> => {
      if (!enabled || !snapshot || busy.current || command.expectedRevision !== snapshot.revision)
        return false;
      busy.current = true;
      setError("");
      try {
        const response = await fetch("/api/admin/news-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        });
        if (
          response.status !== 200 ||
          !validSave((await response.json()) as unknown, command)
        ) {
          throw new Error("Source change rejected");
        }
        const next = await loadSnapshot();
        if (next.revision !== command.expectedRevision + 1) {
          throw new Error("Unexpected source revision");
        }
        setSnapshot(next);
        return true;
      } catch {
        // After any ambiguous write/network outcome, remove stale forms and
        // require a fresh load. Never replay the POST automatically.
        setSnapshot(null);
        setError("Änderung nicht bestätigt. Seite neu laden und Quellenstatus prüfen.");
        return false;
      } finally {
        busy.current = false;
      }
    },
    [enabled, snapshot],
  );

  return (
    <section className="jobs-section" aria-labelledby="news-sources-title">
      <h2 id="news-sources-title">Nachrichtenquellen</h2>
      <p>
        Neue Quellen und Änderungen benötigen persönliche Admin-Freigabe und dokumentierte
        Nutzungsrechte. Freigabe im Register startet keine automatischen Nachrichtenabrufe.
      </p>
      {!enabled ? (
        <div className="notice" role="status">
          Quellenverwaltung ist noch nicht freigeschaltet. Keine Anbieter-URLs eingeben.
        </div>
      ) : loading ? (
        <p role="status">Lade geschütztes Quellenregister …</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {enabled && !loading && snapshot ? (
        <NewsSourceEditor
          sources={snapshot.sources}
          revision={snapshot.revision}
          ready
          onCommand={onCommand}
        />
      ) : null}
    </section>
  );
}
