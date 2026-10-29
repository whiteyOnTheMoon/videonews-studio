"use client";

import { useState, type FormEvent } from "react";
import {
  validRankingPolicyCommit,
  validRankingPolicySettings,
  validRankingPolicySnapshot,
  type RankingPolicySettings,
  type RankingPolicySnapshot,
} from "../../lib/editorial-ranking-policy";

const PROFILE = /^[a-z][a-z0-9_-]{2,40}$/;
const WEIGHTS: readonly {
  key: keyof RankingPolicySettings;
  label: string;
  min: number;
  max: number;
}[] = [
  {
    key: "minimumPublisherGroups",
    label: "Mindestens verschiedene Herausgebergruppen",
    min: 2,
    max: 5,
  },
  { key: "relevanceWeight", label: "Relevanzgewicht", min: 0, max: 100 },
  { key: "freshnessWeight", label: "Aktualitätsgewicht", min: 0, max: 100 },
  { key: "qualityWeight", label: "Herausgeberqualitätsgewicht", min: 0, max: 100 },
  { key: "explanatoryWeight", label: "Erklärwertgewicht", min: 0, max: 100 },
  { key: "visualizabilityWeight", label: "Visualisierbarkeitsgewicht", min: 0, max: 100 },
  { key: "riskWeight", label: "Risikoabzug", min: 0, max: 100 },
  { key: "maximumRisk", label: "Maximal zulässiges Risiko", min: 0, max: 5 },
];
const BLANK: RankingPolicySettings = {
  minimumPublisherGroups: 2,
  relevanceWeight: 0,
  freshnessWeight: 0,
  qualityWeight: 0,
  explanatoryWeight: 0,
  visualizabilityWeight: 0,
  riskWeight: 0,
  maximumRisk: 0,
};

async function load(profileId: string): Promise<RankingPolicySnapshot> {
  const response = await fetch(
    "/api/admin/editorial-ranking-policy?profileId=" + encodeURIComponent(profileId),
    { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" },
  );
  if (response.status !== 200) throw new Error("Ranking policy unavailable");
  const raw: unknown = await response.json();
  if (!validRankingPolicySnapshot(raw) || raw.profileId !== profileId)
    throw new Error("Ranking policy snapshot mismatch");
  return raw;
}

/** Personally attributed policy reviews; source quality and event factors are reviewed separately. */
export default function EditorialRankingPolicy({ enabled }: { enabled: boolean }) {
  const [profileId, setProfileId] = useState("");
  const [snapshot, setSnapshot] = useState<RankingPolicySnapshot | null>(null);
  const [settings, setSettings] = useState<RankingPolicySettings>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  if (!enabled) {
    return (
      <section className="jobs-section">
        <h2>Gewichtetes Nachrichtenranking</h2>
        <p role="status">Ranking-Policy-Prüfung nicht freigeschaltet.</p>
      </section>
    );
  }

  async function read(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!PROFILE.test(profileId) || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    setSnapshot(null);
    try {
      const current = await load(profileId);
      setSnapshot(current);
      setSettings(current.settings ?? { ...BLANK });
    } catch {
      setError("Ranking-Policy konnte nicht persönlich authentifiziert geladen werden.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !validRankingPolicySettings(settings) || busy) {
      setError("Alle Gewichtungs- und Risikogrenzen prüfen.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await fetch("/api/admin/editorial-ranking-policy", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: snapshot.profileId,
          expectedRevision: snapshot.policyRevision,
          settings,
        }),
      });
      if (result.status !== 200) throw new Error("Unconfirmed policy");
      const body: unknown = await result.json();
      if (!validRankingPolicyCommit(body) || body.policyRevision !== snapshot.policyRevision + 1)
        throw new Error("Unconfirmed policy revision");
      const fresh = await load(snapshot.profileId);
      if (
        fresh.policyRevision !== body.policyRevision ||
        fresh.profileRevision !== snapshot.profileRevision
      )
        throw new Error("Unconfirmed policy state");
      setSnapshot(fresh);
      setSettings(fresh.settings ?? { ...BLANK });
      setMessage(
        "Gewichtung persönlich und revisionsgesichert gespeichert. Keine Veröffentlichungsfreigabe.",
      );
    } catch {
      setSnapshot(null);
      setError("Änderung nicht bestätigt. Profil und Policy bitte erneut laden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" aria-labelledby="ranking-policy-heading">
      <h2 id="ranking-policy-heading">Gewichtetes Nachrichtenranking</h2>
      <p>
        Persönlich auditierte Profilgewichte. Herausgeber-Provenienz und Ereignisfaktoren müssen
        zusätzlich unabhängig geprüft werden. Keine Fakten- oder Veröffentlichungsfreigabe.
      </p>
      <form onSubmit={(event) => void read(event)}>
        <label htmlFor="ranking-policy-profile">Profil-ID</label>
        <input
          id="ranking-policy-profile"
          value={profileId}
          onChange={(event) => {
            setProfileId(event.target.value);
            setSnapshot(null);
            setMessage("");
          }}
          required
          maxLength={41}
          pattern="[a-z][a-z0-9_-]{2,40}"
        />
        <button type="submit" disabled={busy || !PROFILE.test(profileId)}>
          Policy laden
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {snapshot ? (
        <form onSubmit={(event) => void save(event)}>
          <p>
            Profilrevision {snapshot.profileRevision} · Policyrevision {snapshot.policyRevision}
          </p>
          {snapshot.settings === null ? (
            <p>Noch keine persönlich überprüfte Ranking-Policy für diese Profilrevision.</p>
          ) : null}
          {WEIGHTS.map(({ key, label, min, max }) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type="number"
                min={min}
                max={max}
                step={1}
                required
                value={settings[key]}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: Number(event.target.value),
                  }))
                }
              />
            </label>
          ))}
          <button type="submit" disabled={busy || !validRankingPolicySettings(settings)}>
            Geprüfte Gewichtung speichern
          </button>
        </form>
      ) : null}
    </section>
  );
}
