# P1-09 – KI-Anbieter und API-Keys künftig im Admin-Bereich verwalten

**Entscheidung 25.10.2026:** Der Betreiber möchte OpenAI-/Gemini-Zugangsdaten
und Modellwahl im Admin-Dashboard pflegen statt API-Keys hart zu kodieren.
Englische Videos bleiben die einzige geplante Publikationssprache.
Dieses Paket ist **ausschließlich Git/CI-Vorbereitung**: Es aktiviert weder
eine Eingabemaske noch die Speicherung echter Schlüssel auf dem VPS.

## Gewünschte Admin-Funktion (separat freizuschalten)

Unter **Admin → KI-Anbieter** soll ein berechtigter Administrator künftig
je Anbieter folgende Vorgänge vornehmen können:

- OpenAI und Google Gemini auswählen; weitere Anbieter nach expliziter
  Backend-Prüfung hinzufügen, keine frei definierbaren Ziel-URLs.
- API-Key einmalig in einem Password-Feld eingeben und sicher speichern.
  Anschließend nur `Key vorhanden` / `nicht hinterlegt` und
  Zeitpunkt einer Rotation anzeigen; niemals Klartext erneut anzeigen.
- Schlüssel durch einen neuen ersetzen, ungültig setzen oder entfernen.
  Alle Aktionen als Auditereignis ohne Credential-, Prompt- oder Cookie-Werte.
- Textmodell, englische Sprecherstimme und Sprache unabhängig konfigurieren.
  Modell-/Preisdaten gelten erst nach serverseitiger Validierung; eine
  im UI editierbare Modellkennung autorisiert **keine beliebige API-Anfrage**.
- Budgets sowie Abfragefreigaben getrennt konfigurieren. API-Keys dürfen
  gespeichert sein, obwohl der Provider weiterhin **deaktiviert** ist.
- Keine Upload-/Publikationsfreigabe ohne die vorhandenen Redaktionsgates.

## Prinzip der Schlüsselverwaltung

`db/migrations/0015_ai_provider_admin_configuration.up.sql` erstellt
`vns.ai_provider_settings` und `vns.ai_provider_sealed_credentials`.
Anbieter/Modellauswahl und Credential-Envelope sind getrennte Datensätze.
Alle Anbieter beginnen `enabled=false`; die Datenbank erzwingt sogar
`CHECK (enabled=false)`, bis eine später separat geprüfte Migration
einen Betriebszustand autorisiert. Es werden **keine** Key-Werte eingefügt,
keine Rollen angelegt und **keiner bestehenden Laufzeitrolle** Rechte
auf die beiden Tabellen gewährt. Migration 0015 läuft nur in isolierter CI.

`apps/api/src/provider-credential-crypto.ts` demonstriert AES-256-GCM,
für jeden Schreibvorgang einen zufälligen 96-Bit-Nonce und einen
128-Bit-Authentifizierungstag. Die AAD bindet die Verschlüsselung an
Provider und Envelope-Version. Entschlüsseln mit einem anderen
Provider, geänderten Ciphertexten, falschen Nonces oder einem anderen
Master-Key muss scheitern. Tests benutzen ausschließlich offensichtliche
Fixture-Schlüssel, keine realen Anbieter-Credentials.

Die 32-Byte-Verschlüsselungs-Key-Encryption-Key (KEK) darf später **nicht**
in GitHub, Postgres, Logs, Chat, Browser, ein öffentliches API-JSON
oder ein Docker-Image gelangen. Er müsste separat über eine
root-/dienstgeschützte Docker-Secret-Datei bereitgestellt werden.
Die API-Server-Instanz entschlüsselt nur innerhalb eines ausdrücklich
freigegebenen Provider-Adapters für eine bereits autorisierte Anfrage.
Browser, Web-BFF und Redaktion erhalten keinen Schlüssel zurück.
Die geplante Speicherung ist verschlüsselt im Datenbank-Envelope;
der KEK befindet sich **außerhalb** der Datenbank.

**Wiederherstellung:** Ohne KEK kann selbst ein vollständiges
PostgreSQL-Backup die Anbieterkeys nicht rekonstruieren. Deshalb
braucht eine spätere Freigabe eine dokumentierte Key-Custody,
geschützte unabhängige KEK-Sicherung oder gezielte Rotation nach
Ausfall. Aktuell gibt es bewusst noch **kein Offsite-Backup**.
Das ist ein verbleibendes Risiko und eine gesonderte Betreiberentscheidung.

## Notwendige Backend-/Frontend-Gates vor der ersten echten Eingabe

1. Ausschließlich Admin-Rolle, serverseitige Sitzungs- und
   CSRF-/Origin-Prüfung auf **beiden** Web-BFF und interner API;
   Redakteur- und Reviewer-Rollen dürfen nicht schreiben/lesen.
2. HTTPS-Browser → Next.js-BFF → interne API; niemals
   API-Credentials in Client-Bundles, HTML, React-State-Persistenz,
   URL-Parametern, lokalem Browser-Speicher oder Logzeilen.
3. Begrenzter Request-Body, sensible POST-/PUT-/DELETE-Antworten
   ausschließlich ohne Key, `Cache-Control: no-store`,
   sichere Fehlerbehandlung, anti-brute-force/Ratelimit.
4. Separater eng berechtigter PostgreSQL-Zugang und auditierbare,
   überprüfte Rotation; bestehende Runtime-User dürfen keine
   Key-Tabellen lesen.
5. Verbindliche Anbieter- und Modell-Allowlist mit Preis-Snapshot,
   gesonderte Aktivierung, Testverbindung nur bei ausdrücklicher
   Kostengenehmigung, atomare Budgetreservierung vor jedem
   Anbieteraufruf und kein verdeckter automatischer Retry.
6. Optionaler zusätzlicher Schutz wie MFA für sicherheitskritische
   Schlüsseloperationen, überprüfbare Revocation- und Session-Regeln.
7. Ende-zu-Ende-Tests mit **synthetischen Keys** in CI, Negativtests für
   Auth, CSP, CSRF, Secret-Exfiltration und unautorisierte Provider-Aktivierung.

Bis diese Schutzmaßnahmen umgesetzt und geprüft sind, ist die API für
echte Credential-Verwaltung **absichtlich nicht vorhanden**. Das ist
kein vermeintlich fertiges Dashboard-Feature.

## Verifikation und Grenzen

- `apps/api/src/provider-credential-crypto.test.ts`: AEAD-Roundtrip,
  falscher Provider/KEK, Manipulation, Zufallsnonce, strikt gültige
  Key-Formate und sichere öffentliche Statusdaten ohne Secret.
- `db/tests/0015_ai_provider_admin_configuration.test.sql`:
  beide Anbieter als deaktivierte Platzhalter, editierbare
  Modell-Metadaten, keine freigegebene Aktivierung, Ablehnung
  fehlerhafter Envelopes und fehlende Berechtigungen bestehender Rollen.
- `db/scripts/test_migrations.sh`: Migration 0015 zweimal
  rückbaubar in disposable PostgreSQL 17.
- `db/scripts/test_full_restore.sh`: leere Credentials und deaktivierte
  Provider-Konfiguration auch im isolierten Full-Restore nachweisbar.

**Nicht implementiert:** echte Admin-Eingabeformulare, persistenter
VPS-Keystore, Provider-API-Verbindungen, kostenpflichtige Test-Calls
und produktiver DB-Rollout. Solche Schritte verlangen eine spätere
eindeutige Freigabe. Beszel und andere Docker-Dienste bleiben unberührt.

## Folgeschritt – API-Vertrag für Administratoren (Git-only)

Der [separat dokumentierte Admin-API-Vertrag](P1-09_ADMIN_PROVIDER_API_CONTRACT.md)
prüft bereits `set_key`, `remove_key` und `set_model` mit simuliertem
Speicher und einer echten AES-256-GCM-Testverschlüsselung. Er ist bewusst
nicht in den laufenden API-Server eingebunden; Master-Key-Datei, auditierter
DB-Zugang, browserseitiges Formular und echte Schlüsselannahme fehlen noch.

## Vorbereitung für Master-Key-Dateien (Git-only)

Die [geprüfte Master-Key-Dateigrenze](P1-09_MASTER_KEY_CUSTODY.md)
verlangt eine private Datei mit exakt 32 Rohbytes, sicherem Eigentümer,
ohne Symlink und ohne Gruppen-/Fremdrechte. Sie läuft bisher nur in
isolierten Tests. Auf dem VPS wurde weder ein Schlüssel erzeugt noch
an den laufenden API-Server angeschlossen. Die bewusst vertagte
Backup-Entscheidung bleibt unverändert.
