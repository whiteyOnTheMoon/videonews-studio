# P2 – internes technisches MVP (8. November 2026)

## Definition of Done

Mindestens zwei bereits genehmigte RSS-Quellen liefern gespeicherte
Metadaten in PostgreSQL und im bestehenden persönlichen Admin-Eingang.
Persistierte Kandidaten sind als Rechercheartikel/Ereignisse projizierbar.
Ein Ereignis wird über die bestehende SQL-Ranking-Pipeline und die
persönliche Admin-API bis in den Web-Parser nachgewiesen, falls nötig
mit ausschließlich synthetischen Nachrichten in isolierter CI.
Leere Rankings werden nicht als leere Nachrichtenaufnahme ausgegeben.
Die bisherigen Quellen-, Alters-, Provenienz- und Rollenregeln gelten
weiter; es gibt keine Veröffentlichung.

## MVP-Nachweise

| Teil | Stand |
| --- | --- |
| Echte RSS-/PostgreSQL-Metadaten | Laut Betreiber NASA 1 und NOAA 18 gespeicherte und projizierte Kandidaten; persönliche Inbox aktiv. Keine neue Live-Abfrage. |
| Echte produktive Mehrquellenrangliste | Nicht vorhanden; das aktuelle Profil verlangt zwei Quellen-IDs innerhalb der Altersgrenze und ein gemeinsames Ereignis. |
| Technischer Mehrquellenrangtest | `scripts/ci_p2_integrated_ports.mjs` verarbeitet zwei synthetische RSS-Quellen und je eine Atom-/JSON-Quelle über den bestehenden isolierten Redis/BullMQ- und PostgreSQL-Pfad. Nach nur einer Quelle ist die Rangliste leer; nach zwei RSS-Quellen existiert höchstens ein Metadaten-Ranking, das keine unabhängige Bestätigung behauptet. |
| Persönlicher Admin-Endpunkt und Web-Parser | `scripts/ci_p2_named_admin_live_pg.mjs` und `scripts/ci_p2_web_admin_bridge.mjs` prüfen den tatsächlich persistierten isolierten Rankingdatensatz, Autorisierung, Widerruf und `approvedForPublication=false`. |
| Verhalten ohne Ranking | `apps/web/src/app/admin/editorial-ranked-events.tsx` erläutert auf eine gültige leere Antwort die bestehenden möglichen Filter. Keine Behauptung über konkrete ungeprüfte Quellen. |

Die vollständige integrierte CI muss auf dem PR-Commit erfolgreich
gelaufen sein, bevor der neue Zwei-RSS-Nachweis als **bestanden**
eingestuft wird. Ein Merge allein führt keine Tests auf dem VPS aus.

## Produktive Einschränkungen

Stand 08.11.2026: NASA 1/1, NOAA 18/18, USGS 0/0;
kein gemeinsames aktuelles Mehrquellenereignis, kein produktives
Ranking, keine unabhängigen Herausgeberreviews. Verschiedene
Quellen-IDs sind kein Beweis unabhängiger Herausgeber. Die
isolierten CI-Nachrichten sind keine realen redaktionellen Belege.

Später: reale Ereignisübereinstimmung und unabhängige
Herausgeberprüfung, produktiver Ranking- und Browserdurchlauf,
USGS-Query-URL-Sonderfälle, optionaler Dauerbetrieb und
Veröffentlichungsfähigkeit.

**Keine** erneute NOAA-One-Shot-Ausführung, keine NASA-Limit-Erhöhung,
keine gelockerten USGS-URL-Gates, keine Produktionsdaten-Fälschung,
keine neuen Backups, keine neuen Quellen oder Dienste und **keine
Veröffentlichung**. Diese Änderung enthält ausschließlich CI-Tests
und Dokumentation, weder Migrationen noch produktive Codeänderungen.
