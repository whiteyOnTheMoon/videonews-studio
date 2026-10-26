# P2-02 – Dormanter Feed-Adapter und Polling-Vertrag

**Status:** ausschließlich Git/CI; kein produktiver Scheduler,
keine Feed-Verbindung und keine neuen Kosten.

Der reine `apps/worker/src/feed-poller.ts` stellt einen ausdrücklich
aufzurufenden `poll(now)`-Durchlauf mit injizierten Ports bereit.
Er öffnet selbst keine Netzwerkverbindung und startet keine Timer,
BullMQ-Worker, Redis-/PostgreSQL-Verbindungen oder Hintergrundaufgaben.

## Quellenfreigabe und Lizenzgrenze

- Es werden nur **drei bis fünf** nach P2-01 ausdrücklich
  `approved`-registrierte Quellen in den Modi `rss`, `atom`
  oder `official_api` gewählt. `blocked`, `pending` und
  `html` gelten nicht als feedfähig.
- Der spezifischste Registrierungs-Pfad gewinnt. Ein gesperrter
  Unterpfad kann nicht durch die übergeordnete Allowlist wieder
  freigegeben werden. Artikel-URLs müssen innerhalb des
  **identischen genehmigten Quellbereichs** bleiben.
- Ausschließlich Metadaten (URL, Überschrift, Veröffentlichungsdatum)
  werden als redaktionelle `candidate`-Einträge angeboten.
  Artikeltexte, HTML, Medien und fremde Claims werden weder
  gespeichert noch als verifiziert ausgezeichnet.
- `access`, `usage`, `termsUrl`, `licenseNotes`,
  `reviewedAt` und `intervalMinutes` kommen aus dem
  manuell geprüften P2-01-Register. Ihre Existenz bedeutet
  **keine tatsächliche Prüfung fremder Nutzungsbedingungen**.

## Abrufintervalle, Cache und Duplikate

Die Speicher-Schnittstelle muss `claim(sourceId, now, intervalMinutes)`
**atomar und persistent über mehrere Prozesse** umsetzen. Jeder
erfolgreiche Claim reserviert den Quellen-Zeitslot selbst dann, wenn
der anschließende Fetch oder die Auswertung fehlschlägt.
Der Scheduler überspringt Quellen ohne Claim.

Ein erfolgreicher HTTP-200-Abruf wird in einem auf maximal 128 KiB
begrenzten, konservativen RSS-/Atom- bzw. offiziellen JSON-
Metadatenformat geprüft. `commit` übernimmt nur Kandidaten
mit eindeutiger Kombination aus Quellen-ID und kanonischer URL;
ETag/Last-Modified sind Teil derselben persistenten Operation.
HTTP 304 erzeugt keinen neuen Kandidaten und bewahrt die
bisherigen Validatoren. Fehler werden als generischer Status
`failed` ausgegeben, ohne Response- oder Secret-Inhalte.

Die Tests verwenden ausschließlich injizierte in-memory Ports und
synthetische RSS-/Atom-/JSON-Antworten. Sie prüfen drei freigegebene
Quellen, ausgeschlossene Quellen und URL-Pfade, Mindestabstand,
304/ETags, wiederholte Meldungen, fehlende Aktivierung, defekte Feeds,
unerlaubte Inhalte und den begrenzten Fehlerstatus.

## Nicht enthalten – vor Live-Rollout zwingend

- Keine produktive DB-/Redis-Persistenz der Claims, Cache-
  Validatoren und idempotenten Kandidaten. Der CI-Speicher ist
  **kein** verteilter Lock und darf niemals produktiv verwendet werden.
- Kein tatsächlicher HTTPS-Transport. Ein späterer Live-Adapter
  muss den bereits bestehenden DNS-gepinnten SSRF-Schutz,
  TLS-Validierung, Byte-/Timeout-Limits, Redirect-Verbot,
  Content-Type-/ETag-Checks und per Quelle genehmigte Abrufgrenzen
  nachweisen. Unbegrenztes `fetch()` ist kein zulässiger Ersatz.
- Kein automatischer Cron-/Timer-Scheduler, keine Queue-Verknüpfung,
  kein Deploy am VPS, keine echte Quellenfreigabe und keine
  produktive Datenbankmigration. Die bestehende Probe-Queue
  und `apps/worker/src/index.ts` sind unverändert.
- Der konservative Parser unterstützt nur kontrollierte RSS-/Atom-
  Basis-Metadaten und ein explizites JSON-`items`-Format.
  Allgemeines XML, vollständige Feeds oder fremde
  providerabhängige APIs sind nicht garantiert kompatibel.

**Abnahme:** Dieses Arbeitspaket ist ein testbarer Offline-Vertrag.
Die ursprünglichen Kriterien in #17 (echte Feed-Meldungen sicher
ingestieren und produktiv interval-/ToS-konform abrufen) sind erst
mit unabhängiger Transport- und Persistenzabnahme erfüllt.
Für die rein synthetische Demonstration entstehen keine
providerseitigen Gebühren.
