"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export interface EditableEditorialProfile {
  id: string;
  language: string;
  keywords: string[];
  blockedTerms: string[];
  minIndependentSources: number;
  maximumArticleAgeHours: number;
  format: "briefing" | "analysis" | "explainer";
}
export interface EditorialProfileSnapshot {
  revision: number;
  profiles: EditableEditorialProfile[];
}
const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseEditorialProfileSnapshot(value: unknown): EditorialProfileSnapshot | null {
  if (
    !object(value) || Object.keys(value).length !== 2 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !Array.isArray(value.profiles) || value.profiles.length > 20
  ) return null;
  const seen = new Set<string>();
  const profiles: EditableEditorialProfile[] = [];
  for (const raw of value.profiles as unknown[]) {
    if (
      !object(raw) || Object.keys(raw).length !== 7 ||
      typeof raw.id !== "string" || !ID.test(raw.id) || seen.has(raw.id) ||
      typeof raw.language !== "string" || !LOCALE.test(raw.language) ||
      !Array.isArray(raw.keywords) || !Array.isArray(raw.blockedTerms) ||
      ![...raw.keywords, ...raw.blockedTerms].every(
        (term) => typeof term === "string" && term.length >= 2 && term.length <= 50,
      ) ||
      !Number.isSafeInteger(raw.minIndependentSources) ||
      (raw.minIndependentSources as number) < 1 ||
      (raw.minIndependentSources as number) > 5 ||
      !Number.isSafeInteger(raw.maximumArticleAgeHours) ||
      (raw.maximumArticleAgeHours as number) < 1 ||
      (raw.maximumArticleAgeHours as number) > 720 ||
      !["briefing", "analysis", "explainer"].includes(raw.format as string)
    ) return null;
    seen.add(raw.id);
    profiles.push(raw as unknown as EditableEditorialProfile);
  }
  return { revision: value.revision as number, profiles };
}
async function fetchSnapshot(signal?: AbortSignal): Promise<EditorialProfileSnapshot> {
  const response = await fetch("/api/admin/editorial-profiles", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (response.status !== 200) throw new Error("Profile administration unavailable");
  const result = parseEditorialProfileSnapshot((await response.json()) as unknown);
  if (!result) throw new Error("Profile revision invalid");
  return result;
}
const EMPTY = {
  id: "",
  language: "",
  keywords: "",
  blockedTerms: "",
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing" as const,
};
function terms(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/** All identifiers, languages and keywords are operator input; no productive defaults. */
export default function EditorialProfiles({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<EditorialProfileSnapshot | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(enabled);
  const locked = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetchSnapshot(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Persönliches Profilregister nicht verfügbar.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled]);

  async function persist(profiles: EditableEditorialProfile[]) {
    if (!enabled || !snapshot || locked.current) return;
    locked.current = true;
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/editorial-profiles", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: snapshot.revision, profiles }),
      });
      if (response.status !== 200) throw new Error("Profile write not confirmed");
      const value: unknown = await response.json();
      if (
        !object(value) || Object.keys(value).length !== 3 ||
        value.saved !== true || value.productionActive !== false ||
        value.revision !== snapshot.revision + 1
      ) throw new Error("Profile revision not confirmed");
      const fresh = await fetchSnapshot();
      if (fresh.revision !== snapshot.revision + 1) {
        throw new Error("Unexpected profile revision");
      }
      setSnapshot(fresh);
      setDraft(EMPTY);
      setNotice("Änderung revisionsgesichert. Kein Scheduler oder KI-Anbieter aktiviert.");
    } catch {
      setSnapshot(null);
      setError("Änderung unbestätigt. Neu anmelden bzw. Profilregister neu laden.");
    } finally {
      locked.current = false;
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !ID.test(draft.id) || !LOCALE.test(draft.language)) return;
    const keywords = terms(draft.keywords);
    const blockedTerms = terms(draft.blockedTerms);
    if (
      keywords.length > 30 || blockedTerms.length > 30 ||
      [...keywords, ...blockedTerms].some(
        (term) => term.length < 2 || term.length > 50,
      )
    ) {
      setError("Schlüsselwörter und Sperrbegriffe bitte prüfen.");
      return;
    }
    const profile: EditableEditorialProfile = {
      id: draft.id,
      language: draft.language,
      keywords,
      blockedTerms,
      minIndependentSources: draft.minIndependentSources,
      maximumArticleAgeHours: draft.maximumArticleAgeHours,
      format: draft.format,
    };
    const next = snapshot.profiles.filter((item) => item.id !== profile.id);
    next.push(profile);
    if (next.length > 20) {
      setError("Maximal zwanzig Profile zulässig.");
      return;
    }
    void persist(next);
  }
  return (
    <section className="jobs-section" aria-labelledby="editorial-profiles-heading">
      <h2 id="editorial-profiles-heading">Nischen- und Sprachprofile</h2>
      <p>Persönlich auditierte Konfiguration. Profile starten keine Nachrichtenabrufe oder KI-Aufrufe.</p>
      {!enabled ? <p role="status">Profilverwaltung nicht freigeschaltet.</p> : null}
      {loading && enabled ? <p role="status">Lade Profile …</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {enabled && !loading && snapshot ? (
        <>
          <p>Aktuelle Revision: {snapshot.revision}</p>
          <ul>
            {snapshot.profiles.map((profile) => (
              <li key={profile.id}>
                <strong>{profile.id}</strong> – {profile.language} ({profile.format})
                <button
                  type="button"
                  onClick={() => setDraft({
                    ...profile,
                    keywords: profile.keywords.join(", "),
                    blockedTerms: profile.blockedTerms.join(", "),
                  })}
                >
                  Bearbeiten
                </button>
                <button
                  type="button"
                  onClick={() => void persist(snapshot.profiles.filter((item) => item.id !== profile.id))}
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={save}>
            <label htmlFor="editorial-profile-id">Nischenkennung</label>
            <input id="editorial-profile-id" value={draft.id} required
              onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
            <label htmlFor="editorial-profile-language">Sprache (z. B. de-DE)</label>
            <input id="editorial-profile-language" value={draft.language} required
              onChange={(event) => setDraft({ ...draft, language: event.target.value })} />
            <label htmlFor="editorial-profile-keywords">Schlüsselwörter (kommagetrennt)</label>
            <input id="editorial-profile-keywords" value={draft.keywords}
              onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} />
            <label htmlFor="editorial-profile-blocks">Sperrbegriffe (kommagetrennt)</label>
            <input id="editorial-profile-blocks" value={draft.blockedTerms}
              onChange={(event) => setDraft({ ...draft, blockedTerms: event.target.value })} />
            <label htmlFor="editorial-profile-sources">Mindestzahl unterschiedlicher Quellen</label>
            <input id="editorial-profile-sources" type="number" min={1} max={5} required
              value={draft.minIndependentSources}
              onChange={(event) => setDraft({
                ...draft, minIndependentSources: Number(event.target.value),
              })} />
            <label htmlFor="editorial-profile-age">Maximales Nachrichtenalter in Stunden</label>
            <input id="editorial-profile-age" type="number" min={1} max={720} required
              value={draft.maximumArticleAgeHours}
              onChange={(event) => setDraft({
                ...draft, maximumArticleAgeHours: Number(event.target.value),
              })} />
            <label htmlFor="editorial-profile-format">Skriptformat</label>
            <select id="editorial-profile-format" value={draft.format}
              onChange={(event) => setDraft({
                ...draft, format: event.target.value as EditableEditorialProfile["format"],
              })}>
              <option value="briefing">Briefing</option>
              <option value="analysis">Einordnung</option>
              <option value="explainer">Erklärvideo</option>
            </select>
            <button type="submit">Profil mit Revisionskontrolle speichern</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
