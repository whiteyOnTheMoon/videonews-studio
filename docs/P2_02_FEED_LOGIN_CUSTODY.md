# P2-02: eingeschränkte PostgreSQL-Logins für Feed-Laufzeit

**Status:** Operator-Helfer im GitHub-Review; keine automatische Freischaltung. Die Stage-B-Liveinventur vom 31.10.2026 zeigte bei sauberem Release 13cf56f1ffe683da998c49e18b5e5eaff70bd3aa:

- Quellenexport-Funktion vorhanden.
- Alle drei NOLOGIN-Ausführungsrollen vorhanden.
- **Null** individuelle SQL-Service-Logins für Quellenexport, Feed-Polling und Projektor.
- Eine persönlich genehmigte Quelle noaa_news mit genehmigtem Host www.noaa.gov und Metadatennutzung.
- PostgreSQL und Redis gesund; keine Feed-Producer und -Consumer aktiv.

## Drei getrennte technische Konten

| PostgreSQL-Login | Ausschließlich geerbte Rolle | Lokale Passwortdatei |
| --- | --- | --- |
| vns_source_export_login_prod | vns_source_export_reader | vns_source_export_db_password |
| vns_feed_login_prod | vns_feed_poll_writer | vns_feed_db_password |
| vns_feed_project_login_prod | vns_feed_project_client | vns_feed_project_db_password |

Alle Logins sind NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS. Die Mitgliedschaften erhalten INHERIT TRUE, SET FALSE. Kein Konto wird als Admin oder für einen anderen Feed-Dienst wiederverwendet.

## Kontrollierter Betreiberablauf

Voraussetzung: unabhängige Prüfung und ausdrückliche Freigabe eines **neuen Release-SHA** auf sauberem main, gesunder bestehender Compose-PostgreSQL-17, exakt 61 Migrationen bis 0061, SCRAM-HBA, die erwarteten Rollen und deren minimale Funktionsrechte. Vorhandene oder halbfertige Logins blockieren die Einrichtung. Alle Schritte erfolgen unter Betreiber-UID 1000. Der eingesetzte SHA muss exakt zum ausgecheckten Release passen.

1. **Stage:** python3 scripts/p2_02_feed_login_custody.py --stage --expected-sha FREIGEGEBENER_SHA
   Vor dem Schreiben wird eine read-only DB- und Releaseprüfung durchgeführt. Erst danach entstehen drei unterschiedliche, kryptografisch zufällige Passwortdateien unter secrets/p2-feed-login-custody/. Verzeichnis 0700, Dateien 0600. Ein zweiter Aufruf überschreibt nichts.
2. **Preflight:** python3 scripts/p2_02_feed_login_custody.py --preflight --expected-sha FREIGEGEBENER_SHA
   Prüft nur Release, Rollen und die private Datei-Custody; keine Login-Erstellung.
3. **Apply – nur nach separater ausdrücklicher Freigabe:** VNS_P2_FEED_LOGINS_OPERATOR_APPROVED=CREATE_THREE_RESTRICTED_FEED_LOGINS python3 scripts/p2_02_feed_login_custody.py --apply --expected-sha FREIGEGEBENER_SHA
   Die drei fest benannten LOGINs werden in **einer atomaren SQL-Transaktion** nach erneuter Vorprüfung angelegt. Der anschließende Postcheck verlangt drei eingeschränkte Logins, genau drei je korrekt zugeordnete Rollen und keine Möglichkeit, diese per SET ROLE zu übernehmen.

Klartextpasswörter verbleiben lokal in privaten Dateien. Zur Datenbank gehen ausschließlich je ein frisch gesalzener SCRAM-SHA-256-Verifier über stdin, niemals im Argument, im Commit oder im normalen Log. Bei Fehlern **nicht blind wiederholen**; zuerst lesend diagnostizieren.

## Weitere Produktionsvoraussetzungen

Die gestagten Dateien gehören zunächst dem Operator-UID 1000. Source-Publisher und Feed-Observer laufen unter UID 10001 beziehungsweise UID 10002; sie können diese Dateien absichtlich noch nicht lesen. Separat erforderlich sind passende Laufzeit-Dateicustody, isolierte Redis-ACL, Ed25519-Signer/Verifier, kontrolliertes Handoff und ein externes monotones Revisionsanker-System.

Für die vollständige P2-A-Abnahme sind 3–5 nachweislich erlaubte Quellen unabhängiger Herausgeber geplant. Derzeit ist nur NOAA persönlich freigegeben. Die Anlage der Login-Rollen aktiviert **keinen** Feed-Abruf, Scheduler, Worker, KI-Aufruf oder Veröffentlichung.

Bestehende IONOS-Backups und Beszel-Überwachung bleiben unverändert.
