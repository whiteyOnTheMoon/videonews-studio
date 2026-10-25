# P1-09 — Read-only Admin-KI-Anbieter-Vorschau / BFF (Git-only)

Stand: 2026-10-25. Die geschützte Seite `/admin` bekommt den Abschnitt
**KI-Anbieter** mit den geplanten Rollen von OpenAI und Gemini. Sie
behält die vorhandene Admin-Sessionprüfung. Keine Schlüssel, Modelle
oder Preise werden für diese Vorschau aus dem Browser gespeichert.

## Sicherheitsstatus

- **Standardmäßig ausgeschaltet:** Der neue GET-Proxy prüft zusätzlich
  `VNS_WEB_AI_PROVIDER_READONLY_ENABLED=true` und die bereits
  vorhandene `VNS_WEB_ADMIN_ENABLED=true`-Konfiguration. Im normalen
  Stand zeigt die UI nur die inaktiven Anbieter und unbekannten
  Schlüsselstatus. Die Flagge wird weder in Docker noch auf dem VPS gesetzt.
- `GET /api/admin/ai-providers` prüft das Format des einzigen
  `__Host-vns_session`-Cookies und validiert die echte Admin-Rolle
  zusätzlich über die bestehende interne `/admin/me`-Route, bevor
  die inaktive interne `/admin/ai-providers`-Route angefragt wird.
  Beide Verbindungen sind auf die bereits freigegebene interne API-Adresse
  beschränkt und verwenden `cache:no-store`, `redirect:manual`
  und kurze Timeouts.
- Antworten werden strikt auf genau zwei bekannte Anbieter,
  ausgewählte zugelassene Modellkennung, `configured:boolean`
  und `active:false` begrenzt. Zusätzliche Felder wie `apiKey`,
  `ciphertext`, URLs, unbekannte Modelle, aktive Anbieter oder
  fehlerhafte Payloads werden mit einer **generischen** Fehlermeldung
  abgewiesen. Schlüsselwerte oder rohe Backend-Fehler werden nicht
  an den Browser weitergereicht.
- Kein `POST`, `PUT`, `PATCH` oder `DELETE` in dieser
  neuen Next.js-Route. Ein Schlüssel-Eingabefeld existiert nicht.
- Die interne Anbieterroute ist absichtlich weiter nicht mit
  `apps/api/src/server.ts` verbunden. Selbst mit aktivierter
  Read-only-Flagge erscheint bis zur späteren geprüften Integration
  lediglich `temporarily_unavailable` – kein Key wird akzeptiert.

## Tests

`apps/web/src/lib/admin-ai-providers-proxy.test.ts` prüft
Flag-gating, nicht autorisierte Browser, tatsächliche Admin-Rolle,
Cookie-Weitergabe ausschließlich an die erlaubte interne API,
Methodensperre, Umleitungen, unbekannte und geheimnistragende Felder,
fehlerhafte bzw. übergroße Antworten und sichere Fehlertexte.

`apps/web/src/app/admin/ai-providers.test.tsx` prüft die
barrierearme sichtbare Vorschau ohne Formulare oder Password-Felder.
Die Tests laufen wie die übrigen Next.js-Tests ausschließlich mit
synthetischen Werten.

## Bis zur Freischaltung ausstehend

Separat genehmigter Master-Key-Custody- und Wiederherstellungsplan,
persönliche Admin-Identität, dedizierter Postgres-Login mit Minimalrechten,
komplett getesteter credential-mutation BFF, sichere Browserformulare,
auditierte E2E-Integration und explizite Aktivierungs-/Kostenfreigabe.
Migrationen 0015/0016 sind auf dem VPS nicht installiert.
Beszel und laufende Docker-Container bleiben unverändert.

Der Betreiber hat bestätigt, **vorerst ohne unabhängiges Backup**
weiterzuarbeiten. Das bedeutet bewusstes Datenverlust- und
Master-Key-Wiederherstellungsrisiko, kein bestehendes Backup.
Keine Schlüssel sollten vor der getrennten Schutz-/Rolloutfreigabe
in VideoNews Studio eingegeben werden.

## Inaktiver BFF-Schreibvertrag (PR-Folgeschritt)

Der [serverseitig geprüfte Admin-Schreibvertrag](P1-09_ADMIN_AI_PROVIDER_WRITE_CONTRACT.md)
modelliert `set_key`, `remove_key` und `set_model` mit strikt
validierten synthetischen Daten. Er bleibt **unregistriert** und kann
im laufenden System keine API-Keys empfangen. Es existiert weiterhin
keine schreibende Next.js-Route und keine produktive Master-Key-Datei.

## Admin-Eingabemaske als nicht-interaktive Vorschau

Die neue Komponente `apps/web/src/app/admin/ai-provider-settings-preview.tsx`
zeigt pro Anbieter die vorgesehenen Eingabeelemente: API-Key,
Modellauswahl und festgelegte Videosprache **English (en)**;
für Gemini ist außerdem eine spätere Sprecherstimmenwahl erkennbar.
Die Oberfläche stellt Speichern, Ersetzen, Entfernen und
Modellübernahme dar, aber **jeder einzelne Eingabe-, Auswahl- und
Aktionsknopf ist dauerhaft `disabled`**.

Es gibt weder ein HTML-Formular noch `onSubmit`-/`onChange`-
Routinen, Key-State, lokal gespeicherte Credentials oder schreibende
Fetch-Aufrufe. Ein deaktiviertes Password-Feld trägt immer den leeren
Wert, selbst wenn ein Backend später `configured:true` meldet;
nur `hinterlegt`/ `nicht hinterlegt` darf erscheinen.
Die Modelldarstellung wird zusätzlich auf die vorhandenen
statischen Provider-Modelle begrenzt. Diese Testkennungen
sind **keine** Freigabe realer Anbieterpreise oder Modelle.

Die bestehende `/api/admin/ai-providers`-Next.js-Route bleibt
**GET-only** und ist weiterhin standardmäßig ausgeschaltet.
Die zukünftige schreibende BFF aus dem vorangegangenen Schritt
wird von keinem produktiven Route-Handler importiert. Auch ein
Setzen der Read-only-Flagge kann die deaktivierten Felder nicht
freischalten.

`apps/web/src/app/admin/ai-provider-settings-preview.test.tsx`
und der aktualisierte `ai-providers.test.tsx` prüfen die
Deaktivierung aller Controls, die leere Schlüsselanzeige,
den festen Sprachhinweis, die Rollenbeschreibung und
fehlende Formulare. Das sind isolierte SSR-/Unit-Tests,
**keine Freigabe für echte Schlüssel**.

Der Betreiber arbeitet ausdrücklich weiterhin vorerst ohne
unabhängiges Backup. Es wird weder ein Backup eingerichtet,
noch ein Master-Key bereitgestellt oder eine Migration ausgeführt.
