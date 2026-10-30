"use client";

import { useState, type FormEvent } from "react";
import {
  validPublisherReviewSnapshot,
  validEventFactorReviewSnapshot,
  validMetadataReviewSaved,
  type PublisherReviewSnapshot,
  type EventFactorReviewSnapshot,
  type PublisherReviewWrite,
  type EventFactorReviewWrite,
} from "../../lib/editorial-review-metadata";

const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

async function getSource(id: string): Promise<PublisherReviewSnapshot> {
  const response = await fetch(
    "/api/admin/editorial-publisher-review?sourceId=" + encodeURIComponent(id),
    { credentials: "same-origin", cache: "no-store", redirect: "error" },
  );
  if (!response.ok) throw new Error("Publisher unavailable");
  const value: unknown = await response.json();
  if (!validPublisherReviewSnapshot(value) || value.sourceId !== id) {
    throw new Error("Publisher response invalid");
  }
  return value;
}
async function getEvent(id: string, profile: string): Promise<EventFactorReviewSnapshot> {
  const response = await fetch(
    "/api/admin/editorial-event-factors?eventId=" + encodeURIComponent(id) +
      "&profileId=" + encodeURIComponent(profile),
    { credentials: "same-origin", cache: "no-store", redirect: "error" },
  );
  if (!response.ok) throw new Error("Event factors unavailable");
  const value: unknown = await response.json();
  if (!validEventFactorReviewSnapshot(value) ||
      value.eventId !== id || value.profileId !== profile) {
    throw new Error("Event factor response invalid");
  }
  return value;
}
async function saveReview(path: string, payload: PublisherReviewWrite | EventFactorReviewWrite) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Review refused");
  const value: unknown = await response.json();
  if (!validMetadataReviewSaved(value)) throw new Error("Review confirmation invalid");
}

/** Separate human reviews. Feed metadata never supplies its own ranking factors. */
export default function EditorialMetadataReviews({ enabled }: { enabled: boolean }) {
  const [sourceId, setSourceId] = useState("");
  const [source, setSource] = useState<PublisherReviewSnapshot | null>(null);
  const [publisherGroup, setPublisherGroup] = useState("");
  const [quality, setQuality] = useState(0);
  const [eventId, setEventId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [factor, setFactor] = useState<EventFactorReviewSnapshot | null>(null);
  const [explanatoryValue, setExplanatoryValue] = useState(0);
  const [visualizability, setVisualizability] = useState(0);
  const [risk, setRisk] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  if (!enabled) {
    return (
      <section className="jobs-section">
        <h2>Redaktionelle Herkunfts- und Ereignisprüfung</h2>
        <p role="status">Persönliche Metadatenprüfungen nicht freigeschaltet.</p>
      </section>
    );
  }
  async function loadSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ID.test(sourceId) || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setSource(null);
    try {
      const current = await getSource(sourceId);
      setSource(current);
      setPublisherGroup(current.publisherGroup ?? "");
      setQuality(current.quality ?? 0);
    } catch {
      setError("Quellenprüfung nicht verfügbar oder Quelle nicht mehr freigegeben.");
    } finally {
      setBusy(false);
    }
  }
  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || source.reviewed || !ID.test(publisherGroup) || busy ||
      !Number.isSafeInteger(quality) || quality < 0 || quality > 5) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveReview("/api/admin/editorial-publisher-review", {
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        publisherGroup,
        quality,
      });
      const fresh = await getSource(source.sourceId);
      if (!fresh.reviewed || fresh.sourceRevision !== source.sourceRevision ||
        fresh.publisherGroup !== publisherGroup || fresh.quality !== quality) {
        throw new Error("Source review not confirmed");
      }
      setSource(fresh);
      setNotice("Herausgeberzuordnung persönlich dokumentiert. Keine Quellen- oder Veröffentlichungsfreigabe.");
    } catch {
      setSource(null);
      setError("Quellenprüfung nicht bestätigt. Bitte Quelle neu laden.");
    } finally {
      setBusy(false);
    }
  }
  async function loadFactors(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!UUID.test(eventId) || !ID.test(profileId) || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setFactor(null);
    try {
      const current = await getEvent(eventId, profileId);
      setFactor(current);
      setExplanatoryValue(current.explanatoryValue ?? 0);
      setVisualizability(current.visualizability ?? 0);
      setRisk(current.risk ?? 0);
    } catch {
      setError("Ereignisprüfung nicht verfügbar. Aktuelle Ranking-Policy und Ereignis kontrollieren.");
    } finally {
      setBusy(false);
    }
  }
  async function saveFactors(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!factor || factor.reviewed || busy ||
      ![explanatoryValue, visualizability, risk].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 5,
      )) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveReview("/api/admin/editorial-event-factors", {
        eventId: factor.eventId,
        profileId: factor.profileId,
        profileRevision: factor.profileRevision,
        policyRevision: factor.policyRevision,
        explanatoryValue,
        visualizability,
        risk,
      });
      const fresh = await getEvent(factor.eventId, factor.profileId);
      if (!fresh.reviewed || fresh.profileRevision !== factor.profileRevision ||
        fresh.policyRevision !== factor.policyRevision ||
        fresh.explanatoryValue !== explanatoryValue ||
        fresh.visualizability !== visualizability || fresh.risk !== risk) {
        throw new Error("Event factor review not confirmed");
      }
      setFactor(fresh);
      setNotice("Ereignisbewertung persönlich erfasst. Erneute Projektion für den SQL-Score erforderlich.");
    } catch {
      setFactor(null);
      setError("Ereignisbewertung nicht bestätigt. Bitte Ereignis neu laden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="review-metadata-heading">
      <h2 id="review-metadata-heading">Redaktionelle Herkunfts- und Ereignisprüfung</h2>
      <p>
        Manuelle, personengebundene Metadatenbewertungen. Verschiedene Quellen-IDs
        beweisen keine unabhängigen Herausgeber. Keine Lizenz- oder Faktenfreigabe.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <h3>Herausgebergruppe und Quellenqualität</h3>
      <form onSubmit={(event) => void loadSource(event)}>
        <label htmlFor="publisher-review-source-id">Freigegebene Quellen-ID</label>
        <input id="publisher-review-source-id" required maxLength={41}
          pattern="[a-z][a-z0-9_-]{2,40}" value={sourceId}
          onChange={(event) => {
            setSourceId(event.target.value);
            setSource(null);
          }} />
        <button type="submit" disabled={busy || !ID.test(sourceId)}>Quelle prüfen</button>
      </form>
      {source ? (
        source.reviewed ? (
          <p role="status">
            Quelle {source.sourceId} · Registerrevision {source.sourceRevision} ·
            Herausgeber {source.publisherGroup} · Qualitätsstufe {source.quality}/5.
            Unveränderlich dokumentiert.
          </p>
        ) : (
          <form onSubmit={(event) => void saveSource(event)}>
            <p>Quellenregisterrevision: {source.sourceRevision}</p>
            <label htmlFor="publisher-review-group">Geprüfte Herausgebergruppe</label>
            <input id="publisher-review-group" required maxLength={41}
              pattern="[a-z][a-z0-9_-]{2,40}" value={publisherGroup}
              onChange={(event) => setPublisherGroup(event.target.value)} />
            <label htmlFor="publisher-review-quality">Quellenqualität (0–5)</label>
            <input id="publisher-review-quality" type="number" min={0} max={5}
              step={1} required value={quality}
              onChange={(event) => setQuality(Number(event.target.value))} />
            <button type="submit" disabled={busy || !ID.test(publisherGroup)}>
              Herausgeberprüfung speichern
            </button>
          </form>
        )
      ) : null}
      <h3>Erklärwert, Visualisierbarkeit und Risiko</h3>
      <form onSubmit={(event) => void loadFactors(event)}>
        <label htmlFor="event-factor-id">Ereignis-UUID</label>
        <input id="event-factor-id" required value={eventId} maxLength={36}
          onChange={(event) => {
            setEventId(event.target.value);
            setFactor(null);
          }} />
        <label htmlFor="event-factor-profile">Profil-ID</label>
        <input id="event-factor-profile" required maxLength={41}
          pattern="[a-z][a-z0-9_-]{2,40}" value={profileId}
          onChange={(event) => {
            setProfileId(event.target.value);
            setFactor(null);
          }} />
        <button type="submit" disabled={busy || !UUID.test(eventId) || !ID.test(profileId)}>
          Ereignis laden
        </button>
      </form>
      {factor ? (
        factor.reviewed ? (
          <p role="status">
            Profilrevision {factor.profileRevision} · Policyrevision {factor.policyRevision} ·
            Erklärwert {factor.explanatoryValue}/5 · Visualisierbarkeit
            {factor.visualizability}/5 · Risiko {factor.risk}/5.
            Unveränderlich dokumentiert.
          </p>
        ) : (
          <form onSubmit={(event) => void saveFactors(event)}>
            <p>Profilrevision {factor.profileRevision} · Policyrevision {factor.policyRevision}</p>
            {([
              ["Erklärwert", explanatoryValue, setExplanatoryValue],
              ["Visualisierbarkeit", visualizability, setVisualizability],
              ["Risiko", risk, setRisk],
            ] as const).map(([name, value, setter]) => (
              <label key={name}>
                {name} (0–5)
                <input type="number" min={0} max={5} step={1} required value={value}
                  onChange={(event) => setter(Number(event.target.value))} />
              </label>
            ))}
            <button type="submit" disabled={busy}>Ereignisbewertung speichern</button>
          </form>
        )
      ) : null}
    </section>
  );
}
