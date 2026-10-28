# P1-09 – Zwei getrennte Provider-Worker-Datenbanklogins

Status: vorbereitet, **noch nicht auf dem VPS ausgeführt**. Bezieht sich auf
[#227](https://github.com/whiteyOnTheMoon/videonews-studio/issues/227) und
[#230](https://github.com/whiteyOnTheMoon/videonews-studio/issues/230).

## Ergebnis

`scripts/p1_09_provider_worker_login_custody.py` stellt zwei *verschiedene*
PostgreSQL-Logins mit SCRAM-SHA-256-Passwörtern bereit:

| Login | Geerbte NOLOGIN-Rolle | Zweck |
|---|---|---|
| `vns_provider_usage_login` | `vns_provider_usage_writer` | Einmalige Reservierung, Budget-Claim, Nutzungsbeleg und Abrechnung |
| `vns_provider_secret_login` | `vns_provider_secret_reader` | Einmalig verschlüsselten Schlüsselumschlag nach SQL-Claim lesen |

Für beide wird `GRANT ... WITH INHERIT TRUE, SET FALSE` benutzt.
Weder der Datenbank-Superuser noch der Admin-Provider-Writer wird als
Worker-Identität wiederverwendet. Direkter SELECT auf verschlüsselte
Anbieterschlüssel, UPDATE der Budgetpolicy, Rechte zur Rollenverwaltung und
Zugriff auf die jeweils andere SQL-Funktion sind ausgeschlossen.

## Harte Vorbedingungen

Das Provisionierungsskript verweigert die Ausführung, wenn:

- Git nicht auf sauberem `main` steht oder der ausführende UID nicht 1000 ist
- der Docker-Container nicht der gesunde PostgreSQL-Container des
  Compose-Projekts `videonews-studio` ist
- die Datenbank nicht PostgreSQL 17 mit `vns` als Eigentümer, dem exakten
  Ledger `0001–0043` und SCRAM-Authentifizierung entspricht
- die beiden NOLOGIN-Rollen fehlen oder bereits andere Mitglieder besitzen
- einer der beiden neuen Logins bereits existiert
- Anbieter, Budget oder EUR-Policy aktiviert sind oder bereits verschlüsselte
  Anbieter-Keys existieren
- `secrets/` nicht dem Besitzer mit Modus 0700 gehört
- die zwei Dateien fehlen, per Symlink referenziert werden, nicht dem
  Besitzer gehören, unterschiedliche Modi haben oder identische Passwörter
  enthalten

Die einmaligen Login-Passwörter werden lokal mit kryptografisch sicherem
Zufall erstellt und in Dateien 0600 unter `secrets/` gespeichert. Der
Datenbanktransaktion werden **nur SCRAM-Verifier** über stdin übergeben;
weder Klartextpasswörter noch Verifier stehen in Kommandozeilenargumenten,
Git, normalen Logs oder der Admin-Oberfläche.

## Betreiberablauf (erst nach gesonderter VPS-Freigabe)

Diese Befehle sind **Dokumentation für einen späteren kontrollierten
Rollout**, nicht zur sofortigen Ausführung.

1. Vorher erfolgreiche und wiederherstellbare IONOS-Backups sowie Beszel
   als bereits bestätigte Betreiberkontrollen verifizieren. Bestehendes
   PostgreSQL-Schema und Migrationen per **read-only Inventur** prüfen.
2. Zuerst **separat** die additiven Migrationen `0019–0043` kontrolliert
   testen und ausrollen. Das bisherige Upgrade-Hilfsskript deckt nur
   `0012–0018` ab und ist hierfür **nicht geeignet**.
3. Nach erfolgreicher Migration und gegen den freigegebenen `main`-Commit
   können die beiden privaten Dateien einmalig angelegt werden:

   ```bash
   python3 scripts/p1_09_provider_worker_login_custody.py --stage
   ```

4. Den read-only SQL- und Schlüsseldatei-Check ausführen:

   ```bash
   python3 scripts/p1_09_provider_worker_login_custody.py --preflight
   ```

5. **Erst nach ausdrücklicher Betreiberfreigabe** die zwei LOGINs in einer
   einzigen SQL-Transaktion anlegen:

   ```bash
   VNS_P1_WORKER_LOGIN_PROVISION_APPROVED=PROVISION_LOGINS_ONLY \
     python3 scripts/p1_09_provider_worker_login_custody.py --apply
   ```

Nach einem Fehler **keinesfalls blind wiederholen**. Keine automatische
Rotation, keine Lösch- oder Rückbauaktionen auf der produktiven DB.
Der Befehl aktiviert weder Worker noch Anbieter, liest keinen
API-Key und erzeugt keine kostenpflichtigen Requests.

Der separate und standardmäßig deaktivierte
`deploy/compose.provider-worker-preflight.yaml` prüft danach auf zwei
eigenen PostgreSQL-Verbindungen die Laufzeitberechtigungen. **Der normale
`apps/worker/src/index.ts` wird nicht verändert oder aktiviert.**

## CI-Sicherheitsnachweise

- Python-Tests kontrollieren exklusive Erstellung, Verzeichnis- und
  Datei-Rechte, Symlink-Verweigerung, getrennte Passwörter, SCRAM-Verifier
  ohne Klartext, fehlende Freigabe und read-only Inventur.
- `db/tests/0043_provider_worker_logins.test.sql` legt in beiden isolierten
  Migrationstestzyklen temporäre LOGIN-Rollen an, kontrolliert direkte und
  indirekte Funktions- und Tabellenrechte und setzt alle Änderungen mit
  `ROLLBACK` zurück.
- Kein produktives Docker, Redis oder API-Transport wird gestartet.

## Weiterhin offen

Es gibt **noch kein freigegebenes VPS-Upgrade `0019–0043`**, keinen
laufenden KI-Worker, keine unabhängig verifizierten offiziellen
Anbieterpreise, keine garantierten Provider-Tokenlimits und keinen
live abgeglichenen Rechnungsbeleg. Eine Abnahme von P1-09 folgt erst
nach kontrollierter Integration und einem **gesondert autorisierten**
Kostentest mit insgesamt höchstens 1 €.
