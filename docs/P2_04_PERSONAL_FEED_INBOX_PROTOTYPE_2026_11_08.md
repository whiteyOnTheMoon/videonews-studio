# P2-04: Persönlicher Nachrichten-Eingang für einen nutzbaren internen Prototypen

**Status: Code und Offline-CI. Keine VPS-Migration, kein Live-Feed-Start, keine Freigabe zur Veröffentlichung.**

## Ziel

Der existierende persönliche Admin-Bereich zeigt nur gespeicherte Rankings,
deren Profil-, Alters-, Sperrlisten-, Provenienz- und Quellenprüfungen bereits
erfüllt sind. Dadurch bleibt die Rankingliste trotz vorhandener
Feed-Metadaten leer. Für den internen Prototypen wird die neue, bewusst
getrennte Ansicht **Nachrichteneingang (ungeprüfte Metadaten)** eingeführt.
Sie zeigt bis zu 25 bereits gespeicherte Feed-Kandidaten, deren Quellen-ID,
Original-Veröffentlichungszeitpunkt und den Zustand der
Artikel-/Ereignisprojektion. Sie berechnet **keinen Score**.

## Sicherheitsgrenzen

Die neue PostgreSQL-Funktion in Migration 0063 ist unter
vns_p2_named_executor (NOLOGIN) geschützt und nur durch
vns_p2_named_client nach persönlichem session_user-Abgleich ausführbar.
Die No-Login-Rolle bekommt ausschließlich den benötigten SELECT auf
feed_poll_candidates. Der normale Web-/API-User erhält keine direkten
Tabellenrechte. Auf jede Ausgabe wirken die **aktuellen**, unabhängig
genehmigten Source-/Host- und URL-Scope-Schranken. Bei Revocation darf
der nächste Lesevorgang keine Kandidaten der Quelle mehr ausgeben.

Der vorhandene Autorisierungs-Helper nutzt FOR SHARE; dieser SELECT muss
daher mit den bisherigen PostgreSQL-Sitzungsrechten laufen und **darf
nicht** als explizite read-only-Transaktion mit dem Helper aufgerufen
werden. Der neue Endpoint verändert keine Daten und verarbeitet keine
Feed-HTTP-Anfrage. API und Next.js-BFF verweigern fehlende oder falsche
persönliche Anmeldung, POST, extraneous Queryparameter, größere Seiten
und unbekannte Felder. Die Antwort ist no-store, metadataOnly=true,
rankingApplied=false und für jede Zeile approvedForPublication=false.
Es werden keine Roh-URLs, Texte, Secrets, Prompt-Inhalte oder Medien
an den Browser weitergegeben.

## Voraussetzungen und separate Rollout-Freigaben

Die neue Migration 0063 ist eine separat zu genehmigende Erweiterung
hinter dem bestehenden Schema bis 0062. Die aktive Release-Version,
PostgreSQL-Schema, API-Web-Builds und persönliche Editor-Sitzung müssen
vor einem VPS-Rollout geprüft werden. Vor Produktion bleiben CI,
SQL-Prüfung an einer Wegwerf-Datenbank, Backup-/Recovery-Risikoabnahme,
Rollout mit Rollback und persönlicher Login-Test erforderlich. Der PR
wird weder selbständig gemergt noch auf dem VPS installiert.

Abnahme im Browser nach ausdrücklich genehmigtem Rollout: persönlich
als Admin anmelden, **Nachrichteneingang** öffnen, NOAA-/NASA-Metadaten
mit Originalzeit und dem Status projiziert/nicht projiziert vergleichen,
aktuelle Host-Revocation im nächsten Lesevorgang als Ausblendung prüfen,
anschließend die getrennte Nachrichtenrangliste betrachten. Keine
Ranking-Zeile ohne regelkonforme aktuelle Mehrquellen-Evidenz, kein
Veröffentlichen-Button.

## Offene P2-Fertigstellung

P2-03: acht historische NOAA-Kandidaten noch nicht projiziert; separate
One-Shot-Projektor-PRs #463 und #464 bleiben eigenständige Abnahmen.
P2-04: echte aktuelle passende Mehrquellenartikel, geprüfte
Herausgeberunabhängigkeit, Ranking-Persistenz und Authenticated-Admin
End-to-End-Abnahme fehlen. Die neue Eingangsliste ist **ein nutzbares
sichtbares Teilergebnis, kein Beweis einer fertigen Nachrichtenredaktion**.
