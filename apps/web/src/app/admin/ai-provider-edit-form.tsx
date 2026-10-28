"use client";

import { useRef, useState, type FormEvent } from "react";
import type { AdminAiProvider } from "../../lib/admin-ai-provider-view";
import {
  makeKeyCommand,
  makeModelCommand,
  makeRemoveCommand,
  type ProviderEditCommand,
} from "./ai-provider-edit-model";

/**
 * Future interactive form. NOT imported from /admin or any deployed route.
 * `onCommand` is intentionally injected: no fetch, URLs or secret storage here.
 * A future rollout must supply an authenticated, audited and rate-limited BFF.
 */
export default function AiProviderEditForm({
  provider,
  selectedModel,
  configured,
  ready = false,
  onCommand,
}: {
  provider: AdminAiProvider;
  selectedModel: string;
  configured: boolean;
  ready?: boolean;
  onCommand: (command: ProviderEditCommand) => Promise<boolean>;
}) {
  const keyInput = useRef<HTMLInputElement>(null);
  const [model, setModel] = useState(selectedModel);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!ready) {
    return (
      <p role="status">
        Sichere Schlüssel-Eingabe noch nicht freigeschaltet. Keine Zugangsdaten eingeben.
      </p>
    );
  }

  const prefix = `provider-edit-${provider}`;

  async function commit(command: ProviderEditCommand) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const confirmed = await onCommand(command);
      setMessage(
        confirmed
          ? "Änderung durch den Server bestätigt; der Anbieter bleibt deaktiviert."
          : "Änderung nicht bestätigt. Den aktuellen Anbieterstatus erneut prüfen.",
      );
    } catch {
      // Never echo request bodies, internal errors, keys or ciphertext.
      setMessage("Änderung nicht bestätigt. Den aktuellen Anbieterstatus erneut prüfen.");
    } finally {
      if (keyInput.current) keyInput.current.value = "";
      setConfirmRemoval(false);
      setBusy(false);
    }
  }

  function replaceKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const candidate = keyInput.current?.value;
    if (keyInput.current) keyInput.current.value = "";
    const command = makeKeyCommand(provider, candidate);
    if (!command) {
      setMessage("Ungültiger Schlüssel. Bitte das Eingabeformat prüfen.");
      return;
    }
    void commit(command);
  }

  function changeModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const command = makeModelCommand(provider, model);
    if (!command) {
      setMessage("Dieses Modell ist nicht zugelassen.");
      return;
    }
    void commit(command);
  }

  function removeKey() {
    if (busy) return;
    const command = makeRemoveCommand(provider, configured, confirmRemoval);
    if (!command) {
      setMessage("Entfernen erfordert eine ausdrückliche Bestätigung.");
      return;
    }
    void commit(command);
  }

  return (
    <div className="admin-provider-editor" aria-label={`KI-Anbieter ${provider} verwalten`}>
      <p role="status">
        Nur Konfiguration: Auch nach einem erfolgreichen Speichern bleibt der Anbieter deaktiviert.
      </p>
      <form className="admin-form" onSubmit={replaceKey} autoComplete="off">
        <label htmlFor={`${prefix}-key`}>
          {configured ? "API-Key ersetzen" : "API-Key hinterlegen"}
        </label>
        <input
          id={`${prefix}-key`}
          name="new-provider-key"
          ref={keyInput}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          minLength={12}
          maxLength={512}
          required
          disabled={busy}
        />
        <p>Bereits gespeicherte Schlüssel werden niemals angezeigt.</p>
        <button type="submit" disabled={busy}>
          {busy ? "Übermittlung läuft …" : "Schlüssel sicher übermitteln"}
        </button>
      </form>
      <form className="admin-form" onSubmit={changeModel}>
        <label htmlFor={`${prefix}-model`}>Zugelassenes Modell</label>
        <input
          id={`${prefix}-model`}
          type="text"
          value={model}
          maxLength={80}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
        />
        <p>Nur Modelle mit gültiger, persönlich geprüfter Preisversion werden serverseitig zugelassen.</p>
        <button type="submit" disabled={busy}>
          Modell speichern
        </button>
      </form>
      {configured ? (
        <div className="admin-form">
          <label htmlFor={`${prefix}-confirm-remove`}>
            <input
              id={`${prefix}-confirm-remove`}
              type="checkbox"
              checked={confirmRemoval}
              onChange={(event) => setConfirmRemoval(event.target.checked)}
              disabled={busy}
            />
            Ich möchte den hinterlegten Anbieter-Schlüssel entfernen.
          </label>
          <button type="button" disabled={busy || !confirmRemoval} onClick={removeKey}>
            Schlüssel entfernen
          </button>
        </div>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
