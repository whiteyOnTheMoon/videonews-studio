"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (response.ok) {
        router.replace("/admin");
        router.refresh();
      } else if (response.status === 429) {
        setMessage("Zu viele Anmeldeversuche. Bitte später erneut versuchen.");
      } else if (response.status === 401) {
        setMessage("Anmeldung fehlgeschlagen.");
      } else {
        setMessage("Anmeldung derzeit nicht verfügbar.");
      }
    } catch {
      setPassword("");
      setMessage("Anmeldung derzeit nicht verfügbar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="admin-form">
      <label htmlFor="admin-password">Admin-Passwort</label>
      <input
        id="admin-password"
        type="password"
        autoComplete="current-password"
        value={password}
        maxLength={1024}
        required
        disabled={busy}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Prüfe …" : "Anmelden"}
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}
