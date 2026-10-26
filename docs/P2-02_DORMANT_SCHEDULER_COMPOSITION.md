# P2-02 – Isolierte Feed-Scheduler-Komposition

**Stand:** ausschließlich Git/CI. Dieser Baustein importiert und verknüpft die
bereits vorbereiteten Quellenregister-, PostgreSQL- und HTTPS-Adapter in einem
einzelnen, ausdrücklich aufzurufenden Offline-Durchlauf. Er ist **nicht** in
`apps/worker/src/index.ts`, BullMQ, Cron, Docker oder den VPS eingebunden.

## Sicherheits- und Startgrenzen

`createDormantFeedScheduler(env, ports)` verweigert die Konstruktion, sofern
nicht alle Bedingungen gleichzeitig erfüllt sind:

- `VNS_FEED_OFFLINE_COMPOSITION_ENABLED=true`
- `VNS_FEED_OFFLINE_OPERATOR_ACK=true`
- `VNS_FEED_REGISTRY_FILE=/run/secrets/reviewed_research_sources.json`
- `VNS_SOURCE_FETCH_ENABLED=true` und eine gültige, getrennte
  `VNS_ALLOWED_SOURCE_HOSTS`-Allowlist
- Ein explizit injizierter PostgreSQL-`Pool`, eine Registry-Lesefunktion und
  **beide** DNS-/HTTPS-Transportfunktionen. Es gibt **keinen** impliziten
  Zugriff auf das echte Netzwerk und keine automatisch geöffneten
  Verbindungen.

Alle Gates und Schnittstellen werden geprüft, **bevor** das Register gelesen
oder SQL/DNS angesprochen werden kann. Fehler beim Lesen des Registers
erscheinen nur als generische Meldung; Geheimnisse werden nicht ausgegeben.

Der Registry-Parser erzwingt geprüfte URL-Bereiche, Status, Rechte,
Zugriffsmodi, Prüfdatum und Intervalle. Die Pooling-Komposition verlangt wie
bisher **drei bis fünf genehmigte** RSS-/Atom-/JSON-Quellen. Gesperrte oder
nicht freigegebene Quellbereiche werden vor DNS, Abruf und Persistenz
ausgeschlossen. Der Rückgabewert erlaubt nur `tick(now)` – keinerlei Timer
oder Hintergrundprozess wird angelegt.

## Nachweise

Die Tests verbinden tatsächlich den Reader für ein synthetisches Register,
die Host-Freigabe, die Produktionsparser und die vorhandenen Adapter mit
injizierten Fake-Ports. Geprüft werden:

- drei genehmigte RSS-/Atom-/JSON-Quellen durch die ganze Kette
  `Registry → Poller → DNS-gepinnter Transport → Parser → SQL-Claim/Commit`
- eindeutige Kandidaten mit `reviewStatus: candidate` und ohne HTML/
  Volltext- oder verifizierte Claim-Daten
- erneuter Tick vor Ablauf ohne DNS, HTTP oder neues Commit
- ETag-Weitergabe und HTTP 304 ohne zusätzliche Kandidaten
- verweigerte Start-Flags, fehlende Ports, fehlendes Register,
  unzureichende Freigabe und ungültige Hosts
- private DNS-Antworten und Datenbank-Ausfälle mit redigierten
  Fehlerresultaten ohne Fetch.

**Achtung:** Der SQL-Port in diesen Kompositionstests ist eine
in-memory-Doppelinstanz. Die realen, transaktionalen und
konkurrierenden PostgreSQL-Tests für die Migration 0019 wurden
bereits separat mit PR #233 grün abgenommen. Ebenso wurden TLS-/DNS-
Sonderfälle isoliert in PR #234 getestet. Dieser neue Test bestätigt
die **Zusammenschaltung**, nicht einen Live-Quellenabruf.

## Vor Produktivbetrieb weiterhin erforderlich

Ein dedizierter, nachweislich minimal berechtigter DB-LOGIN und Pool,
genehmigte Servermigration mit echtem Backup/Restore (#228),
Betreiberfreigabe von konkreten 3–5 Quellen mit ToS-/Lizenzprüfung,
operativ freigegebener Netzwerkzugang, realer End-to-End-Test mit
Quelle/ETag und sauberer redaktioneller Datenbankanbindung.
Cron-/BullMQ-Scheduler, Alarmierung (#229), Wiederanlauf und
Rollback benötigen eine **gesonderte** kontrollierte Freigabe.

Keine laufenden Docker-Änderungen, keine realen Netzabrufe, keine
produktiven Migrationen, keine KI-Anfragen oder neuen Kosten.
Issues #16 und #17 bleiben bis zur echten Live-Abnahme offen.
