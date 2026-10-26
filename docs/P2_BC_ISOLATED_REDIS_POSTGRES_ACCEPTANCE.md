# P2 B/C – Isolierter Redis-PostgreSQL-End-to-End-Nachweis

## Zweck

Die bestehende synthetische Feed→Queue→SQL→Redaktion-Komposition kann eine
reale BullMQ-Zustellung und eine reale PostgreSQL-Transaktion bislang nicht
gemeinsam beweisen. Der isolierte CI-Job
`.github/workflows/p2-isolated-ports.yml` startet **nur auf einem kurzlebigen
GitHub-Actions-Runner** PostgreSQL 17 und Redis 7 und führt
`scripts/ci_p2_integrated_ports.mjs` aus.

Die Prüfung verwendet drei ausschließlich erfundene Feed-Quellen und eine
injizierte HTTPS-Fixture. Sie kontaktiert **keine Nachrichtenanbieter**.
Keine Cron-Zeitplanung, kein Dauerbetrieb, keine KI-Aufrufe, kein VPS-Deploy,
keine Veröffentlichung und kein Eingriff in bestehende Redis-Queues sind
damit verbunden. Die realen Ports sind ausschließlich CI-Instanzen.

## Abgedeckte Prüfungen

1. Das Datenbankschema wird anhand aller vorhandenen Migrationen in einer
   neuen, wegwerfbaren PostgreSQL-Datenbank aufgebaut. Ein gesonderter
   PostgreSQL-LOGIN erhält **nur** die Rolle `vns_feed_poll_writer`.
2. Ein tatsächlicher BullMQ-Worker und eine reale Redis-Queue übermitteln
   genau einen Slot-Job; derselbe Slot darf nicht doppelt verarbeitet werden.
   Bestehende produktive Probe- und Research-Queues bleiben unberührt.
3. Die genehmigte Fixture-Registry wird vor dem Feed-Tick geprüft. Die drei
   RSS-/Atom-/offiziellen JSON-Fixtures werden durch den injizierten
   DNS-gepinnten Transport-Port verarbeitet. PostgreSQL persistiert ausschließlich
   Metadaten-Kandidaten und ETag, keine Volltexte.
4. Die SQL-Rechte verhindern, dass der Feed-Poll-LOGIN eigenmächtig
   `vns.project_feed_candidates` ausführen kann. Nur ein separater
   CI-Prüfkontext löst die Projektion explizit aus. Zweite Projektion
   bleibt idempotent.
5. Normalisierung, Kandidaten-Clustering, Ranking, Entwurf, Qualitäts-/Claim-Gate
   und Report werden anhand der **wirklich gespeicherten** Kandidaten geprüft.
   Drei verschiedene Source-IDs mit **derselben Publisher-Gruppe** dürfen
   keine unabhängige Verifikation vortäuschen. Der Export muss stets
   `approvedForPublication: false` enthalten.

## Grenzen und offene Produktionsabnahmen

Der CI-Lauf beweist nicht die Berechtigung realer Anbieter, DNS-/Netzwerk-
Verfügbarkeit unter Produktionslast, offsite Wiederherstellung, eine
dauerhaft betriebene Scheduler- und Worker-Instanz, sichere persönliche
Login- und Secret-Verwahrung, menschliche unabhängige Faktenprüfung,
vollständige revisionssichere Protokoll-Abgabe oder rollierende
Produktionsmigration. Selbst bei grüner CI bleiben die Issues P2-01 bis
P2-10 bis zur separaten Abnahme offen.

**Absichtlich nicht enthalten:** automatische Freigabe, API-Keys,
hartkodierte echte News-Anbieter, Modelle/Provider, produktive Timer oder
Login-Vergabe. Aktivierungen müssen durch explizit geprüfte Operator-
Konfiguration und einen getrennten Rollout erfolgen.

## Separater, default-off BullMQ-Bridge-Vertrag

`apps/worker/src/feed-bullmq-bridge.ts` kapselt jetzt den tatsächlich
getesteten Queue-/Worker-Aufbau. Er verwendet den eigenen Prefix
`bull:vns:feed` und die Queue `vns-feed-poll` (getrennt von bestehenden
Probe- und Research-Queues), strikt `concurrency: 1`, ausschließlich
injizierte Redis-Verbindungen und die vorhandene Feed-Job-Validierung.
Zusätzlich zu den bestehenden Offline-/Queue-Gates müssen die beiden
Flags `VNS_FEED_BULLMQ_BRIDGE_ENABLED=true` und
`VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK=true` gesetzt sein. Fehlende
Schalter oder ungültige Ports werden vor dem Aufbau von BullMQ-Objekten
zurückgewiesen.

Die Bridge besitzt **keinen automatischen Zeitgeber** und wird weiterhin
weder von `apps/worker/src/index.ts` noch von der produktiven
Docker-Komposition importiert. Die Redis-Zugänge werden weder erzeugt
noch aus einer hartkodierten Quelle bezogen. Der bestehende CI-Test
verwendet diese Bridge jetzt selbst, statt einen abweichenden Test-Worker
manuell zu konstruieren. Das ist eine Integration des Anwendungscodes,
**keine** Freischaltung eines produktiven Services.
