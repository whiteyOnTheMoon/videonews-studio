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
