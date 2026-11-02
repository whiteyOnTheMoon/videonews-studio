# P2-04 – Persistierte Rankings bis zum Web-BFF und Admin-Parser

Die isolierte CI hatte bereits signierte synthetische Feed-Quellen,
Redis/BullMQ, PostgreSQL, Ranking und die persönliche Admin-API mit
einem tatsächlichen PostgreSQL-Login nachgewiesen. Dieser Baustein
erweitert **denselben** Integrationstest bis zur Web-Zwischenschicht
(`dormantEditorialAdminProxy`) und zum Parser der redaktionellen
Ranking-Ansicht (`parseRankedCandidatePage`).

Die bestehende Verbindung wird nicht nachgebaut oder durch eine
simulierte Ranking-JSON ersetzt. Der Web-BFF richtet seinen festen
GET-Endpunkt an den wirklichen persönlichen API-Handler, dessen
SQL-Anfragen weiterhin unter `editor_ci_fullchain` gegen dieselben
persistierten Rankings laufen. Ausschließlich die synthetische
Cookie-zu-Admin-Identitätsabfrage wird im disposablen Runner
bereitgestellt; ein echter Browser-Login wird damit **nicht**
als produktiv getestet ausgegeben.

Der Test prüft die Kette unter folgenden Bedingungen:

- HTTP 200 mit `no-store`, `nosniff`, `no-referrer`
  und genau dem persistierten synthetischen Kandidaten mit drei
  Artikeln und drei verschiedenen Quell-IDs.
- Die Web-Zwischenschicht übermittelt ausschließlich Felder des
  geprüften Kandidatenvertrags; Veröffentlichung bleibt
  `approvedForPublication=false`.
- Das API-Login wird auf PostgreSQL-Ebene widerrufen, die
  historischen Ranking-Daten bleiben gespeichert, der Web-BFF darf
  keine Kandidaten mehr an den Browser zurückgeben. Nach dem
  rein synthetischen Zurücksetzen des Logins funktioniert die
  Lesekette wieder.
- POST auf den Ranking-Endpunkt, doppelte Query-Parameter und
  fehlerhafte Cookie-Werte werden **vor** jedem Upstream-Aufruf
  abgelehnt.
- Ein BFF darf nicht mehr Datensätze akzeptieren, als mit
  `limit` verlangt wurden – auch wenn alle Einträge einzeln gültig
  aussehen.
- Während eines neu gestarteten authentifizierten Abrufs darf die
  Admin-Oberfläche keine zuvor gespeicherten Kandidaten mehr
  darstellen. Fehler und deaktivierte Ansicht bleiben ebenfalls
  leer.

Die gesamte Testumgebung ist isoliert. Es wird weder der produktive
VPS erreicht noch eine echte Nachrichtenquelle, ein externer
Revisionsanker oder ein persönlicher produktiver Account verwendet.
Diese Prüfung ersetzt **nicht** die echte Browser-, VPS-, Quellenrechts-
und Wiederanlauf-Abnahme. Sie berechtigt niemals zur Veröffentlichung.
