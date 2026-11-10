"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { parseFeedInboxPage, type FeedInboxItem } from "../../lib/editorial-feed-inbox";

type Tab = "create" | "videos" | "settings";
interface PreviewFile {
  file: string;
  bytes: number;
  modifiedAt: string;
  reviewRequired: true;
  publishingAllowed: false;
}
type RenderState = "idle" | "running" | "completed" | "failed";

const PILOT = "ozone-2026-explained-en";
const PILOT_LABEL = "Antarktisches Ozonloch 2026 – Earth & Climate Explained (englischer Pilot)";

function NewsSelector({
  enabled,
  renderEnabled,
  openVideos,
}: {
  enabled: boolean;
  renderEnabled: boolean;
  openVideos: () => void;
}) {
  const [news, setNews] = useState<readonly FeedInboxItem[]>([]);
  const [selected, setSelected] = useState(PILOT);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function research() {
    if (!enabled || loading) return;
    setLoading(true);
    setMessage("");
    setNews([]);
    try {
      const res = await fetch("/api/admin/editorial-feed-inbox?limit=25", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (!res.ok) throw new Error("Feed source unavailable");
      const result = parseFeedInboxPage((await res.json()) as unknown);
      if (!result) throw new Error("Invalid inbox");
      setNews(result);
      setSelected((previous) =>
        previous === PILOT || result.some((item) => "feed:" + item.articleUrl === previous)
          ? previous
          : PILOT,
      );
      setMessage(
        result.length
          ? "Gespeicherte Nachrichten geladen. Das ist noch keine neue Live-Recherche. Bitte Quellen prüfen."
          : "Keine gespeicherten Nachrichten anzeigbar. Eine Live-Recherche wurde nicht gestartet.",
      );
    } catch {
      setMessage("Gespeicherte News sind derzeit nicht verfügbar. Keine neue Recherche gestartet.");
    } finally {
      setLoading(false);
    }
  }

  async function createVideo() {
    if (selected !== PILOT || !renderEnabled || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/private-previews/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 202) {
        setMessage("Privater VPS-Testauftrag angenommen. Das Video wird nicht veröffentlicht.");
        openVideos();
      } else if (response.status === 409) {
        setMessage("Es läuft bereits eine Videoerstellung. Unter Videos den Status prüfen.");
        openVideos();
      } else if (response.status === 401 || response.status === 403) {
        setMessage(
          "Videostart nicht freigegeben. Bitte die persönliche Anmeldung und VPS-Freigaben prüfen.",
        );
      } else {
        setMessage("VPS-Renderstart nicht bestätigt. Es wurde keine Fertigstellung behauptet.");
      }
    } catch {
      setMessage(
        "Verbindung unterbrochen. Bitte zuerst unter Videos nach dem Auftragsstatus sehen.",
      );
    } finally {
      setBusy(false);
    }
  }

  const curated = selected === PILOT;
  return (
    <section className="studio-panel" aria-labelledby="studio-create-heading">
      <div className="studio-heading">
        <div>
          <span className="studio-kicker">EARTH & CLIMATE EXPLAINED</span>
          <h2 id="studio-create-heading">Neues Video erstellen</h2>
          <p>
            Wähle ein Thema. Die Folge nutzt sieben feste Kapitel und eine flexible Laufzeit von
            8–10 Minuten.
          </p>
        </div>
        <span className="studio-tag">Private Vorschau</span>
      </div>
      <div className="studio-actions">
        <button
          type="button"
          className="studio-secondary"
          onClick={() => void research()}
          disabled={!enabled || loading}
        >
          {loading ? "Suche gespeicherte News …" : "News recherchieren"}
        </button>
        <button
          type="button"
          className="studio-primary"
          onClick={() => void createVideo()}
          disabled={!renderEnabled || busy || !curated}
        >
          {busy ? "Starte Vorschau …" : "Video erstellen"}
        </button>
      </div>
      <p className="studio-explanation">
        „News recherchieren“ lädt in dieser Stufe <strong>bereits gespeicherte Nachrichten</strong>.
        Ein neuer Live-Abruf ist noch nicht freigeschaltet.
      </p>
      <fieldset className="studio-picker">
        <legend>Welche Nachricht soll erklärt werden?</legend>
        <label className="studio-choice">
          <input
            type="radio"
            name="studio-news"
            value={PILOT}
            checked={selected === PILOT}
            onChange={() => setSelected(PILOT)}
          />
          <span>
            <strong>{PILOT_LABEL}</strong>
            <small>Vorbereitetes, noch ungeprüftes Quellenskript · 9-Minuten-Testziel</small>
          </span>
        </label>
        {news.map((item) => {
          const value = "feed:" + item.articleUrl;
          return (
            <div key={item.sourceId + ":" + item.articleUrl}>
              <label className="studio-choice">
                <input
                  type="radio"
                  name="studio-news"
                  value={value}
                  checked={selected === value}
                  onChange={() => setSelected(value)}
                />
                <span>
                  <strong>{item.headline}</strong>
                  <small>
                    {item.sourceId} · {new Date(item.publishedAt).toLocaleDateString("de-DE")} ·
                    Quellenprüfung erforderlich
                  </small>
                </span>
              </label>
              <a href={item.articleUrl} target="_blank" rel="noopener noreferrer">
                Originalquelle öffnen
              </a>
            </div>
          );
        })}
      </fieldset>
      {!curated ? (
        <p className="studio-explanation" role="status">
          Für diese gespeicherte News fehlt noch ein geprüftes englisches Sieben-Kapitel-Skript.
          Videoerstellung ist bis dahin gesperrt.
        </p>
      ) : null}
      {!renderEnabled ? (
        <p className="studio-explanation" role="status">
          VPS-Videostart ist noch nicht aktiv. Die technische Vorbereitung läuft; es wird kein Video
          im Hintergrund erzeugt.
        </p>
      ) : null}
      {!enabled ? (
        <p className="studio-explanation">Die Rechercheansicht ist noch nicht freigeschaltet.</p>
      ) : null}
      {message ? (
        <p className="studio-feedback" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function PrivateVideos({ enabled }: { enabled: boolean }) {
  const [files, setFiles] = useState<readonly PreviewFile[]>([]);
  const [job, setJob] = useState<RenderState>("idle");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [listRes, statusRes] = await Promise.all([
        fetch("/api/admin/private-previews", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/admin/private-previews/status", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      ]);
      if (!listRes.ok || !statusRes.ok) throw new Error("Private preview not accessible");
      const list: unknown = await listRes.json();
      const status: unknown = await statusRes.json();
      if (
        !list ||
        typeof list !== "object" ||
        !("files" in list) ||
        !Array.isArray(list.files) ||
        !status ||
        typeof status !== "object" ||
        !("state" in status) ||
        !["idle", "running", "completed", "failed"].includes(status.state as string)
      ) {
        throw new Error("Unexpected preview response");
      }
      const rows = list.files as PreviewFile[];
      setFiles(rows);
      setJob(status.state as RenderState);
      setSelected((previous) =>
        rows.some((row) => row.file === previous) ? previous : (rows[0]?.file ?? ""),
      );
      setNotice(
        status.state === "running"
          ? "Das Video wird auf deinem VPS erzeugt."
          : status.state === "failed"
            ? "Letzter Testauftrag fehlgeschlagen. Bitte Serverprotokolle prüfen."
            : "",
      );
    } catch {
      setFiles([]);
      setSelected("");
      setNotice(
        "Private Videodateien sind derzeit nicht erreichbar. Persönliche Anmeldung und VPS-Anbindung prüfen.",
      );
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 12000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const current = files.find((file) => file.file === selected);
  const previewUrl = current
    ? "/api/admin/private-previews/" + encodeURIComponent(current.file)
    : "";
  return (
    <section className="studio-panel" aria-labelledby="studio-videos-heading">
      <div className="studio-heading">
        <div>
          <span className="studio-kicker">PRIVATE MEDIATHEK</span>
          <h2 id="studio-videos-heading">Deine Videos</h2>
          <p>
            Fertige Testdateien direkt vom VPS ansehen oder herunterladen. Keine öffentliche
            Veröffentlichung.
          </p>
        </div>
        <button
          type="button"
          className="studio-secondary"
          disabled={!enabled || loading}
          onClick={() => void refresh()}
        >
          Aktualisieren
        </button>
      </div>
      {!enabled ? <p role="status">Die private VPS-Mediathek ist noch nicht angebunden.</p> : null}
      {enabled && loading ? <p role="status">Lade deine Vorschauen …</p> : null}
      {enabled && job === "running" ? (
        <p role="status" className="studio-feedback">
          Video wird erstellt. Dieser Bereich prüft den Status automatisch.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="studio-feedback">
          {notice}
        </p>
      ) : null}
      {enabled && !loading && files.length === 0 ? (
        <p>Noch keine privaten Videos gefunden.</p>
      ) : null}
      {current ? (
        <>
          <label className="studio-video-select" htmlFor="studio-video-choice">
            Video auswählen
            <select
              id="studio-video-choice"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {files.map((file) => (
                <option key={file.file} value={file.file}>
                  {file.file}
                </option>
              ))}
            </select>
          </label>
          <video
            className="studio-player"
            key={previewUrl}
            controls
            playsInline
            preload="metadata"
            src={previewUrl}
          >
            Dein Browser unterstützt HTML5-Videos nicht.
          </video>
          <div className="studio-video-meta">
            <span>
              Nur Vorschau · nicht veröffentlicht · {(current.bytes / 1048576).toFixed(1)} MB
            </span>
            <a
              className="studio-download"
              href={previewUrl + "?download=1"}
              download={current.file}
            >
              MP4 herunterladen
            </a>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default function StudioDashboard({
  settings,
  newsEnabled,
  previewEnabled,
  renderEnabled,
}: {
  settings: ReactNode;
  newsEnabled: boolean;
  previewEnabled: boolean;
  renderEnabled: boolean;
}) {
  const [active, setActive] = useState<Tab>("create");
  const tabs: { id: Tab; title: string }[] = [
    { id: "create", title: "Erstellen" },
    { id: "videos", title: "Videos" },
    { id: "settings", title: "Einstellungen" },
  ];
  return (
    <div className="studio-layout">
      <div className="studio-tabs" role="tablist" aria-label="Studio-Bereiche">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={"studio-tab-" + tab.id}
            aria-selected={active === tab.id}
            aria-controls={"studio-pane-" + tab.id}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={"studio-pane-" + active} aria-labelledby={"studio-tab-" + active}>
        {active === "create" ? (
          <NewsSelector
            enabled={newsEnabled}
            renderEnabled={renderEnabled}
            openVideos={() => setActive("videos")}
          />
        ) : active === "videos" ? (
          <PrivateVideos enabled={previewEnabled} />
        ) : (
          <div className="studio-settings">{settings}</div>
        )}
      </div>
    </div>
  );
}
