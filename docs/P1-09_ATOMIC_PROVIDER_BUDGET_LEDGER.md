# P1-09 / #230: reservierte Providerkosten, atomare SQL-Abrechnung

**Stand: Offline-Implementierung. Keine VPS-Migration, keine kostenpflichtige
Provider-Anfrage, kein Runtime-LOGIN und keine Betriebsfreigabe.**

## 0037: neue PostgreSQL-Budgetkette

Diese Migration setzt alle vorigen **0001–0036** in korrekter Reihenfolge
voraus. Auf dem VPS ist bisher **0018** bestätigt; **0037 niemals
einzeln** ausführen. Die Migration wurde für zweimaliges Auf-/Abbauen
in einem isolierten CI-PostgreSQL-System konstruiert.

Vier anerkannte Kostengrenzen sind über eine einzige Administrationsrichtlinie
konfigurierbar: **pro Request, pro Job, pro Kalendertag (UTC), pro
Kalendermonat (UTC) und global für das Projekt**. Alle Werte sind
ganzzahlige Mikro-USD-Beträge. Die Projektgesamtgrenze wird nicht
automatisch zurückgesetzt; damit ist auch eine Kombination aus Tages-
und Monatsgrenze nicht geeignet, die Gesamtausgaben zu überschreiten.

Die Policy existiert **default-off** mit Nullgrenzen; sie kann nicht durch
den normalen Worker oder die Provider-Schlüsselverwaltung aktiviert werden.
Preis-Snapshots werden **nicht gesät**. Jeder Snapshot erfordert eine
eindeutige Modell-/Provider-/Preisversion, drei feste Tokenpreise,
Prüferidentität, Herkunft und Ablaufzeit. Ein Snapshot kann nicht geändert
oder gelöscht werden. Nur eine gesonderte Administrator- und
Währungsfreigabe darf ihn später eintragen.

### Reservierung

\`vns.reserve_provider_live_budget(...)\` nimmt die voraussichtlichen
**maximalen** Ein- und Ausgabetokens entgegen und berechnet die
Worst-Case-Kosten serverseitig aus dem geprüften Snapshot. Es wird
**kein Cache-Rabatt** vor der tatsächlichen Antwort angenommen.

Ein einzelner PostgreSQL-Row-Lock auf der globalen Policy serialisiert
Reservierungen auch **zwischen unabhängigen Verbindungen und Jobs**.
Die Funktion betrachtet ausstehende Reservierungen vollständig und
abgerechnete Reservierungen mit dem belegten Ist-Wert. Identische
Request-Retries liefern dieselbe Reservierungs-ID, widersprüchliche
Retries werden abgewiesen.

### Abrechnung

\`vns.settle_provider_live_budget(reservation_id,receipt_id)\` verknüpft
einen vorhandenen, unveränderlichen \`0036\`-Usage-Beleg atomar mit genau
einer Reservierung. Provider, Modell, Job, Request, Preisversion,
Tokenobergrenzen und der aufgerundete, getrennt berechnete Cache-/Text-
Preis müssen übereinstimmen. Gleiches Settlement ist idempotent.

Bei Überbudgetierung, fehlender Preiskonsistenz oder falscher
Response-Zuordnung wird der globale Stop dauerhaft eingeschaltet,
ein unveränderlicher Incident notiert und der belegte Auftrag nicht
als abgeglichen markiert. Die Funktion gibt \`halted\` zurück, statt
eine Exception nach dem Stop auszulösen (eine Exception würde die
Stop-Änderung zurückrollen). Die nutzende Worker-Runtime **muss**
dieses Ergebnis als schwerwiegenden Abbruch behandeln. Fehlende
Usage-Belege bleiben **nicht abgerechnet** und halten die komplette
Reservierung; kein impliziter Null-Euro-Abschluss.

### Grenzen und offene Sicherheitsannahmen

- \`vns_provider_usage_writer\` bleibt NOLOGIN, ohne direkte
  Tabellenrechte; ein produktiver Runtime-LOGIN wird nicht eingerichtet.
- Es existiert noch **kein echter Provider-Transport** und **kein**
  authentifizierter Dispatch, der die Reservierung vor jedem externen
  Request zwingend voraussetzt. SQL ist kein globaler Kill-Switch für
  fremde Clients außerhalb dieser Architektur.
- USD-Limits sind noch **keine EUR-Deckelung**. Für die maximal
  1 EUR des geplanten Canarys fehlen ausdrücklich freigegebene
  EUR/USD-Grenzen, FX-Versionen und eine konservative End-to-End-Sperre.
- Der Tokenpreisvertrag deckt aktuell **Text-only** ab; TTS, Bilder,
  Audio, Werkzeuge, Multi-Modalität, eventuelle Mindestkosten,
  unbekannte Gebühren oder Rechnungskorrekturen bleiben gesperrt.
- Nach fehlender oder verspäteter Usage wird die Reservierung
  nicht freigegeben. Überhöhte oder widersprüchliche Belege lösen
  die Sperre aus und benötigen eine geprüfte Wiederaufnahme.
- Besitzerrechte, Preisfreigabe, Datenbankmigration und eine
  reale Anbindung über Admin-Tool/Worker sind getrennt zu prüfen.
  Die App darf nicht anhand von Text im Request ihre Preise oder
  Ausgabenpolitik ändern.

## Testabnahme

\`db/tests/0037_provider_live_budget_ledger.test.sql\` kontrolliert
Default-off, Rollengrenzen, Preisverfall, Retry-Identität,
Worst-Case-Reservierung, Auslastung aller Grenzen, echte abgerechnete
Tokenmengen, unveränderliche Belege, fehlende Usage und eine
dauerhafte Sperre bei widersprüchlichen Ergebnissen. In
\`db/scripts/test_migrations.sh\` wird zusätzlich gegen zwei
**echte unabhängige PostgreSQL-Sitzungen** nur eine von zwei gleichzeitig
versuchten Reservierungen zugelassen. Die vollständige Migrationsfolge
und das Down/Up laufen in CI zweimal.

Diese Tests sind nur dann als bestanden zu werten, wenn die
zugehörige Pull-Request-CI **vollständig grün** ist. Keine produktiven
Container, Datenbanken, API-Keys oder providerseitigen Preise werden
durch dieses Paket verändert.
