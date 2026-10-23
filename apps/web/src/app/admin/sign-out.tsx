"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setError("Abmeldung nicht bestätigt. Bitte erneut versuchen.");
        return;
      }
      router.replace("/admin/login");
      router.refresh();
    } catch {
      setError("Abmeldung nicht bestätigt. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form">
      <button type="button" onClick={signOut} disabled={busy}>
        {busy ? "Abmeldung …" : "Abmelden"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
