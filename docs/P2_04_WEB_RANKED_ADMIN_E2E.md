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

## Leere Rangliste trotz vorhandener Feed-Ereignisse

Ein erfolgreicher P2-02-Feed-Commit und eine P2-03-Ereignisprojektion führen nicht zwingend zu einer Ranglistenzeile. Die bestehende SQL-Rankingfunktion prüft unter anderem die Mindestzahl verschiedener Quellen-IDs, das Altersfenster, Sperrbegriffe sowie gegebenenfalls die unabhängig erfassten Herausgeber- und Bewertungsbelege. Eine leere persönlich authentifizierte Rankingantwort darf deshalb nicht als „keine Feed-Artikel vorhanden“ interpretiert werden.

Die Admin-Oberfläche erläutert diesen Unterschied jetzt ausdrücklich **nur bei erfolgreichem, leerem Ranking-GET**. Sie ermittelt keine versteckten Artikelzahlen, öffnet keine Datenbank-/Feed-Verbindung und lockert weder SQL- noch persönliche Admin-Berechtigungen. Fehler, deaktivierte Ansicht und laufende Aktualisierung zeigen weiterhin keinen früheren Snapshot und keine unbelegte Produktionsdiagnose.

Produktiver Befund vom 2026-11-07 (VPS-SHA `a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031`): NASA ein Artikel/ein Ereignis, NOAA zehn ältere Artikel/zehn Ereignisse, kein gemeinsames NASA-/NOAA-Ereignis oder 48-Stunden-Paar; das aktuelle Profil verlangt zwei Quellen-IDs und hat nur eine im NASA-Ereignis. Beide Quellen verfügen noch über keine Herausgeber-Provenienzreviews. Die fehlende Rankingzeile ist unter diesen Bedingungen erwartbar und darf nicht durch künstliche Quellenergänzung oder Policy-Absenkung behoben werden. Diese Dokumentation und UI-Meldung sind kein Beleg für eine später erfolgreich angezeigte Admin-Rankingzeile.
