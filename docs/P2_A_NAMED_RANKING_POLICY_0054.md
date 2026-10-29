# P2-A 0054: Persönliche Ranking-Gewichte im Admin-Tool

**Stand:** Default-off Code, noch nicht auf dem VPS ausgerollt.

Die Migration 0054 liefert für bereits bestehende geprüfte
`feed_ranking_policy_reviews` aus 0053 zwei neue, eng begrenzte
Datenbankfunktionen:

- `vns.named_ranking_policy_read(profile_id)`: aktuelle Gewichte
  und Policyrevision für das aktuell vorhandene Nischenprofil.
- `vns.named_ranking_policy_commit(profile_id,expected_revision,settings)`:
  atomarer, append-only CAS-Insert mit persönlichen PostgreSQL-`session_user`-
  und Editor-`auth_version`-Prüfungen. `reviewer_id` wird nur in SQL
  aus der persönlich eingeschriebenen Identität abgeleitet, niemals
  aus der Anfrage. Bereits gespeicherte Reviewzeilen können weder
  überschrieben noch gelöscht werden. Kein API-Login bekommt
  direkte Schreibrechte auf Reviewtabellen.

API, Next.js-BFF und das Admin-Formular bieten einen getrennten,
revisionsgebundenen Lese-/Schreibpfad mit exakten erlaubten Feldern.
Jede POST-Anfrage benötigt die bestehende Origin-Prüfung, das
persönliche Editor-Cookie und eine neue persönlich eingeloggte
PostgreSQL-Verbindung. Gewichtungen sind je 0–100, minimale
Herausgebergruppen 2–5, Risikoschwelle 0–5. Ohne explizite
Quellprovenienz und persönliche Ereignisfaktoren aus 0053
wird weiterhin **kein** gewichteter Kandidat berechnet.

Ein persönlicher Policy-Commit ist keine unabhängige Freigabe der
Inhaltsrechte und keine Publikationsgenehmigung. Die anderen
beiden Gewichtungsreviewregister (Herausgeberqualität und
Ereignisbewertung) haben noch keine persönliche CRUD-Schnittstelle;
sie bleiben unverändert ausschließlich DBA-verwaltet.
Ein Review der Quelle und ein zweiter Hostfreigeber bleiben
getrennte, nicht ersetzbare Schritte.

Die neue Funktion ist standardmäßig nicht aktiv:
`VNS_EDITORIAL_PERSONAL_DB_ENABLED=true` und
`VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK=true` sowie die
bereits bestehenden separaten, persönlich eingerichteten
PostgreSQL-Logins/Secrets und der Web-Admin-Gate sind erforderlich.
Keine Zugangsdaten oder Freigaben werden automatisch eingerichtet.

## Sicherheit und Rollout-Grenzen

Der CI-Migrationstest prüft den realen PostgreSQL-`session_user`,
Revision/CAS, unerlaubte Felder, unzulässige Gewichtungen,
direkte Tabellenprivilegien und Widerruf bei inaktiver
oder geänderter Editoridentität; API/BFF/UI haben Negativtests.

**Nicht erledigt:** Die migrationsreife technische Umsetzung
ersetzt keinen tatsächlichen VPS-Rollout der Migrationen 0049–0054,
keinen Live-RSS-Abruf und keine endgültige NASA/JPL-/NOAA-/USGS-
Rechteprüfung. Bestehende IONOS-Backups und Beszel
werden nicht geändert.
