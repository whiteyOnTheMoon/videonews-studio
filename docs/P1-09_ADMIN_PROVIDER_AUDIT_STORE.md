# P1-09 – Transaktionaler Audit-Speicher für KI-Anbieter (Git/CI-only)

Stand: 25. Oktober 2026. Dies ist **kein freigeschalteter Admin-Key-Speicher**.
Die neue Migration `0016_ai_provider_audit_store` und der inaktive
`PostgresProviderConfigStore` bereiten die Datenbankanbindung vor. Weder
`apps/api/src/server.ts` noch `apps/api/src/index.ts` importieren sie.
Es werden keine Schlüssel hinterlegt, kein VPS-PostgreSQL verändert und
keine OpenAI-/Gemini-Anfragen gestartet.

## Atomare Mutation mit revisionsfähigem Audit

`vns.admin_mutate_ai_provider` ist eine SECURITY-DEFINER-Funktion mit
festgelegtem Suchpfad, strenger Provider-/Modell-Allowlist und binären
Schlüsselfeldern. Sie sperrt den Anbieter-Datensatz per `FOR UPDATE`
und führt **Änderung und Audit-Eintrag in derselben Transaktion** aus.
Wenn der Audit-Eintrag scheitert, wird auch die Änderung zurückgerollt.

- `set_key`: nur vorab verschlüsseltes AES-256-GCM-Envelope
  (12-Byte Nonce, 16-Byte Tag, 12–512 Byte Ciphertext).
  Wiederholtes Setzen ersetzt den Ciphertext und schreibt ein neues Ereignis.
- `remove_key`: entfernt ausschließlich das versiegelte Envelope und
  protokolliert die Anforderung auch dann, wenn kein Schlüssel existiert.
- `set_model`: erlaubt nur die fest hinterlegten OpenAI- und Gemini-Modelle;
  ändert keine Credentials und protokolliert den Modellwechsel.
- Alle Operationen verweigern zusätzliche oder widersprüchliche
  Felder. Ein `enable`-Befehl ist nicht vorhanden. Die DB-Constraint
  aus Migration 0015 verlangt weiter `enabled=false`.

Die Audit-Tabelle `vns.ai_provider_config_events` enthält **keine
Schlüssel, auch keine Teile oder Fingerprints davon**. Sie enthält
Anbieter, Aktion, Zeit und die wahrheitsgemäße Identitätsgrenze
`shared-admin-session` sowie den PostgreSQL-Login, nicht die
Identität einer bestimmten Person. Das bisherige gemeinsame Admin-Konto
ist dafür nicht ausreichend. Später sollte das System individuelle
Admin-Konten und serverseitig nachgewiesene Actor-IDs einsetzen.

Für normale Rollen sind Audit-Ereignisse append-only; auch DELETE/UPDATE
und TRUNCATE über Trigger werden abgelehnt. Ein PostgreSQL-Superuser
kann wie üblich Trigger ändern. Das Audit ist daher kein externer,
manipulationssicherer Logdienst.

## Berechtigungsgrenze

Migration 0016 legt zwei **NOLOGIN**-Rollen ohne Mitgliedschaften an:

- `vns_provider_config_executor`: Besitzer der zwei
  eingeschränkten SECURITY-DEFINER-Funktionen. Die Rolle besitzt die
  benötigten Tabellenspalten- und Envelope-Rechte.
- `vns_provider_config_writer`: darf ausschließlich
  `vns.admin_list_ai_providers()` und
  `vns.admin_mutate_ai_provider(...)` ausführen; besitzt **keine**
  direkten SELECT-/INSERT-/UPDATE-/DELETE-Rechte an den Tabellen.

Weder laufende API-Rollen noch Worker-/Audit-Rollen erhalten Zugang.
Es wird kein Datenbank-LOGIN, kein Passwort und kein ROLE-GRANT
an eine laufende Anwendung erzeugt. Eine spätere Freigabe verlangt
zunächst gesonderte Login-Einrichtung, Berechtigungsprüfung,
Host-Authentifizierung und Audit des Deployments.

## Inaktiver TypeScript-Adapter

`apps/api/src/postgres-provider-config-store.ts` nimmt einen explizit
injizierten `pg.Pool` entgegen. `list()` benutzt ausschließlich
die geschützte Datenbankfunktion für sekretfreie Statusdaten;
`mutateWithAudit()` verwendet ausschließlich die parametrisierte
SQL-Funktion. Ciphertext wird binär übertragen. Der Adapter entschlüsselt
**nie** einen API-Key und führt keinen Provider-Aufruf aus.

Negative Tests lehnen unbekannte Anbieter, fremde Modelle, fehlerhafte
Base64URL-Envelopes und unerwartete Felder vor dem ersten SQL-Aufruf ab.
Interne SQL-Fehler, Connection-Strings und Credentials werden aus Fehlern
gefiltert. Der Vertrag `AdminProviderConfiguration` aus PR #210
bleibt weiterhin bewusst **nicht** in den produktiven Server eingehängt.

## CI- und Restore-Nachweis

- `db/tests/0016_ai_provider_audit_store.test.sql` führt
  synthetische Key-Rotation, Löschung und Modellwechsel unter der
  NOLOGIN-Writer-Rolle aus. Danach wird geprüft, dass genau vier
  korrekte Audit-Einträge entstanden sind und die Credentials leer sind.
- Negativtests prüfen fehlende direkten Tabellenrechte,
  verbotene Aktivierung, falsche Modellzuordnung, fehlerhafte
  Verschlüsselungsfelder und nicht löschbare Audit-Ereignisse.
- `db/scripts/test_migrations.sh` prüft Migration und Rollback
  im isolierten PostgreSQL-17-CI-Container.
- `db/scripts/test_full_restore.sh` prüft Rolle, Funktionsrechte,
  einen modellbezogenen, schlüsselfreien Audit-Testeintrag sowie die
  wiederhergestellte Datenbank. Es werden niemals echte API-Keys als
  CI-Daten verwendet.

**Bewusste offene Punkte:** Master-Key-Custody und Rotation, Audit mit
individueller Admin-Identität, Browser-/BFF-Anbindung, sichere
Datenbank-LOGIN-Bereitstellung, Migration 0015/0016 auf dem VPS,
Ende-zu-Ende-Rechte- und CSP/CSRF-Tests sowie der Umgang mit dem
vorerst nicht eingerichteten Offsite-Backup.

Aktuell sind deshalb **keine echten Key-Eingaben oder KI-Ausgaben
autorisiert**. Bestehendes Docker-Setup und Beszel bleiben unverändert.
Issue #9 bleibt offen.
