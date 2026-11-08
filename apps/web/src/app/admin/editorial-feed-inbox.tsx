"use client";

import { useEffect, useState } from "react";
import { parseFeedInboxPage, type FeedInboxItem } from "../../lib/editorial-feed-inbox";

export default function EditorialFeedInbox({ enabled }: { enabled: boolean }) {
  const [items, setItems] = useState<readonly FeedInboxItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  async function refresh(signal?: AbortSignal) {
    setItems([]);
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/editorial-feed-inbox?limit=25", {
        method: "GET", credentials: "same-origin", cache: "no-store",
        redirect: "error", ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error("Feed inbox unavailable");
      const page = parseFeedInboxPage((await response.json()) as unknown);
      if (!page) throw new Error("Feed inbox malformed");
      if (!signal?.aborted) setItems(page);
    } catch {
      if (!signal?.aborted) {
        setItems([]);
        setError("Nachrichteneingang konnte nicht geladen werden.");
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
    <section className="jobs-section" aria-labelledby="feed-inbox-heading">
      <h2 id="feed-inbox-heading">Nachrichteneingang (ungeprüfte Metadaten)</h2>
      <p>
        Bereits gespeicherte Nachrichten unabhängig vom Ranking.
        Kein Live-Abruf, keine Tatsachenprüfung und keine Veröffentlichungsfreigabe.
      </p>
      {!enabled ? <p role="status">Nachrichteneingang nicht freigeschaltet.</p> : null}
      {enabled ? (
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Lade Nachrichteneingang …" : "Nachrichteneingang aktualisieren"}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {enabled && !loading && !error && items.length === 0 ? (
        <p>Keine aktuell zugelassenen Metadaten anzeigbar. Dies ist kein Nachweis einer leeren Datenbank.</p>
      ) : null}
      {enabled && !loading && !error && items.length > 0 ? (
        <ol>
          {items.map((item, index) => (
            <li key={item.sourceId + ":" + item.publishedAt + ":" + index}>
              <strong>{item.headline}</strong>
              <p>Quelle: {item.sourceId} · {item.projected
                ? "Als Rechercheereignis erfasst" : "Noch nicht projiziert"}</p>
              <p>Veröffentlicht: <time dateTime={item.publishedAt}>{item.publishedAt}</time></p>
              <p>Unverifiziert · Kein Ranking-Score · Keine Veröffentlichungsfreigabe</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
