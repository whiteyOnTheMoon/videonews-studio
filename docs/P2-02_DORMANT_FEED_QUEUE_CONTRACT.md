# P2-02 – Deaktivierte BullMQ-Feed-Orchestrierung

**Status: Git-/CI-Vertrag, niemals automatisch gestartet.**
`apps/worker/src/feed-queue-contract.ts` exportiert ausschließlich eine
Fabrik für das Zusammenspiel einer bereits geprüften Feed-Komposition mit
einer **injizierten** BullMQ-kompatiblen Queue. Der laufende
`apps/worker/src/index.ts` importiert den Vertrag nicht. Es wird keine
Queue, Worker-, Redis-, PostgreSQL-, DNS- oder Timer-Verbindung geöffnet.

## Isolierte Queue

- Fester Name `vns-feed-poll`. Weder `vns-jobs` (Probe) noch
  `vns-research` darf damit verwechselt oder an ihn übergeben werden.
- Kein Job mit benutzerbestimmten URLs, Feed-Text, API-Schlüsseln,
  Credentials, ausgewählten Quellen oder anderen Payload-Feldern.
  Ein zulässiger Job besteht **genau** aus `kind: "feed-tick"` und
  einem sicheren ganzzahligen 15-Minuten-Zeitslot.
- Feste Job-ID `vns-feed-tick-<slot>`. Erneutes Enqueue innerhalb
  eines Zeitslots nutzt dieselbe ID. `attempts: 1`,
  `removeOnComplete: false` und `removeOnFail: false` sorgen
  dafür, dass BullMQ erledigte oder fehlgeschlagene Slot-IDs nicht
  sofort wieder zur Duplikaterzeugung freigibt.
  Ein späterer Betrieb benötigt eine begrenzte Aufbewahrung und
  kontrollierte Bereinigung, ohne das Deduplizierungsfenster zu öffnen.
- Ein Consumer verweigert fremde Queue-/Job-Namen,
  manipulierte Payloads, unpassende Job-IDs, zukünftige oder
  um mindestens 30 Minuten verspätete Jobs. Es gibt keinen
  impliziten Retry bei Quellen-/Datenbankfehlern.
- Für einen einzelnen Consumer wird eine parallele Ausführung
  abgelehnt. Mehrere getrennte Prozesse werden weiterhin durch
  die atomaren PostgreSQL-Claims aus Migration 0019 geschützt.
- Jobantworten enthalten nur aggregierte Zähler.
  Fehlgeschlagene Feed-Abfragen machen den Job generisch
  fehlerhaft und geben **keine** URL, SQL-, Netzwerk- oder
  Credential-Details frei.

## Zusätzliche Startfreigaben

Die Factory verlangt `VNS_FEED_QUEUE_CONTRACT_ENABLED=true`,
`VNS_FEED_QUEUE_OPERATOR_ACK=true`,
`VNS_FEED_OFFLINE_COMPOSITION_ENABLED=true`,
`VNS_FEED_OFFLINE_OPERATOR_ACK=true` und
`VNS_FEED_QUEUE_NAME=vns-feed-poll`. Die zuvor eingerichtete
`createDormantFeedScheduler`-Fabrik muss getrennt und mit
explizit injiziertem Datenbankpool, Registrierungsdatei und
DNS-/HTTPS-Transport erzeugt werden. Kein Umgebungswert
aktiviert den laufenden Probe-Worker von selbst.

Die Syntax-, Zeitfenster-, Freigabe-, Fehler- und
Deduplizierungstests verwenden ausschließlich in-memory
Queue-/Feed-Port-Doubles. Es wurde weder Redis noch ein
öffentlicher News-Feed durch diese Tests kontaktiert.

## Weiterhin vor produktivem Betrieb offen

1. Genehmigter Redis-ACL-Nutzer nur für die Feed-Queue, Begrenzung
   und Aufbewahrung/Pruning der Job-IDs; Redis-AOF-Restore und
   geeignete Stop-/Drain-/Alert-Runbooks.
2. Getrennter PostgreSQL-LOGIN-Pool mit überprüften Rechten,
   produktive Migration 0019, sichere Credentials und
   Recoveryentscheidung gemäß #228.
3. Menschliche Prüfung von drei bis fünf konkreten Quellen,
   Lizenz-/Nutzungsbedingungen und Echtabruf inklusive
   DNS-Pinning, TLS und ETags.
4. Expliziter, kontrolliert freigegebener Queue-Erzeuger,
   Consumer, Aufruftakt, Signal-Handling, Monitoring/Alarmierung
   (#229), Rollback und echter End-to-End-Ingest.

**Keine** Docker-/VPS-Änderung, keine echten Nachrichten-
oder KI-Anfragen, keine Kosten und keine Live-Freigabe.
Issues #16 und #17 bleiben bis zur Betriebsabnahme offen.
