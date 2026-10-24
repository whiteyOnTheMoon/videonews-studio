"use client";

import { useEffect, useState, type FormEvent } from "react";

type EditorRole = "editor" | "reviewer" | "admin";
const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/;

export default function EditorLogin({ enabled }: { enabled: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<EditorRole | null>(null);
  const [activeUsername, setActiveUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    try {
      const response = await fetch("/api/editor/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status !== 200) {
        setRole(null);
        setActiveUsername("");
        return;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid profile");
      const row = data as Record<string, unknown>;
      if (
        Object.keys(row).length !== 2 ||
        typeof row.username !== "string" ||
        !USERNAME.test(row.username) ||
        !["editor", "reviewer", "admin"].includes(row.role as string)
      )
        throw new Error("Invalid profile");
      setRole(row.role as EditorRole);
      setActiveUsername(row.username);
    } catch {
      setRole(null);
      setActiveUsername("");
      setMessage("Redakteur-Sitzung konnte nicht geprüft werden.");
    }
  }

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!USERNAME.test(username) || password.length < 12 || password.length > 256 || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await fetch("/api/editor/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
        cache: "no-store",
      });
      setPassword("");
      if (result.status === 200) {
        await refresh();
        setMessage(
          "Persönliche Anmeldung bestätigt. Nur Reviewer und Administratoren dürfen Quellen bewerten.",
        );
      } else if (result.status === 429) {
        setMessage("Zu viele Anmeldeversuche. Bitte später erneut versuchen.");
      } else if (result.status === 401) {
        setMessage("Anmeldung fehlgeschlagen. Zugangsdaten oder Kontostatus prüfen.");
      } else {
        setMessage("Anmeldung nicht bestätigt. Bitte erneut versuchen.");
      }
    } catch {
      setPassword("");
      setMessage("Verbindung unterbrochen. Sitzungsstatus vor einem neuen Versuch prüfen.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/editor/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setMessage("Persönliche Abmeldung nicht bestätigt.");
        return;
      }
      setRole(null);
      setActiveUsername("");
      setMessage("Persönliche Redakteur-Sitzung beendet.");
    } catch {
      setMessage("Persönliche Abmeldung nicht bestätigt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jobs-section" id="editor-login" aria-labelledby="editor-login-title">
      <h2 id="editor-login-title">Persönliche Redakteur-Anmeldung</h2>
      {!enabled ? (
        <div className="notice" role="status">
          Noch nicht freigeschaltet. Persönliche Redakteur-Anmeldungen bleiben deaktiviert.
        </div>
      ) : role ? (
        <div className="admin-form">
          <p role="status">
            Angemeldet als <strong>{activeUsername}</strong> · Rolle: <strong>{role}</strong>
          </p>
          <p>
            Nur Reviewer und Administratoren können Quellenentscheidungen speichern. Für jede
            Bewertung ist eine Begründung erforderlich.
          </p>
          <button type="button" disabled={busy} onClick={() => void logout()}>
            {busy ? "Persönliche Abmeldung …" : "Redakteur-Sitzung abmelden"}
          </button>
        </div>
      ) : (
        <form className="admin-form" onSubmit={(event) => void login(event)}>
          <p>
            Der gemeinsame Admin-Zugang ersetzt keine persönliche Prüfung. Melde dich für
            redaktionelle Bewertungen zusätzlich mit deinem eigenen Konto an.
          </p>
          <label htmlFor="editor-username">Redakteur-Benutzername</label>
          <input
            id="editor-username"
            value={username}
            autoComplete="username"
            minLength={3}
            maxLength={32}
            required
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
          <label htmlFor="editor-password">Persönliches Passwort</label>
          <input
            id="editor-password"
            type="password"
            value={password}
            autoComplete="current-password"
            minLength={12}
            maxLength={256}
            required
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" disabled={busy || !USERNAME.test(username) || password.length < 12}>
            {busy ? "Anmeldung …" : "Persönlich anmelden"}
          </button>
        </form>
      )}
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}
