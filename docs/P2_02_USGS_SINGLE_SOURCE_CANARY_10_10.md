# P2-02 – Expliziter USGS-Einzelquellen-Canary (10/10)

**Status: Code-/CI-Änderung; keine VPS-Freigabe, keine automatische Recherche und keine Publikation.**

## Ausgangszustand, 2026-11-04

Der Betreiber hat die Quellen-/Host-Revision **10/10** persönlich bestätigt.
Der signierte Ed25519-Export und das Staging wurden auf **10/10** aktualisiert.
Der netzwerklose Import in die private Worker-Inbox war erfolgreich und
bytegleich. Der bisherige Worker-Checkpoint und der gleichberechtigte
same-VPS-PostgreSQL-Revisionsanker stehen noch auf **8/7**. Es wurde kein
weiterer Feed gestartet oder ein Checkpoint/Anker zurückgesetzt.

Die bisherige Code-Zulassung in `feed-canary-source-selection.ts` ermöglichte
nur einen NOAA-Einzelquellen-Canary. Ohne separate USGS-Grenze dürfte der
Operator **nicht** denselben NOAA-Acknowledgement-Token verwenden und dürfte
auch nicht ohne Selektor alle Quellen abfragen.

## Isolierte USGS-Selektion

Nach getrennter Produktionsprüfung und ausdrücklicher Betreiberfreigabe kann
der bestehende, _einmalige_ `feed-observe-once --once` folgenden Zusatz wählen:

- `VNS_FEED_RUNTIME_MODE=single_pass`
- `VNS_FEED_SOURCE_BOOTSTRAP=false` (existierender Checkpoint, niemals neu initialisieren)
- `VNS_FEED_CANARY_SOURCE_ID=usgs_news`
- `VNS_FEED_CANARY_OPERATOR_ACK=USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY`

Die volle dreiquellige signierte Registry bleibt eine zwingende Voraussetzung.
Der ausgewählte Eintrag muss weiterhin `approved`, `rss` und
`metadata_only` sein, die aktuell separat erteilte Host-Freigabe behalten,
und **exakt** diese überprüften URLs haben:

- `baseUrl=https://www.usgs.gov/news/`
- `feedUrl=https://www.usgs.gov/news/149248/feed`

Andere Hosts, geänderte USGS-Endpunkte, ein anderes Acknowledgement, falscher
Modus, `BOOTSTRAP=true`, fehlender Signaturnachweis und ein gesperrter
Quellenbereich werden verweigert. Die beiden anderen Quellen erhalten
**keine** Source-Authority-Abfrage, keinen Poll-Lease, keine DNS-Auflösung,
keinen HTTPS-Abruf und keinen Kandidaten-Commit. Dies gewährt keine
weitergehenden Content-/Medienrechte und umgeht keinen PostgreSQL-Guard.

## Unveränderte Sicherheitsgrenzen

Alle bisherigen Gating-Flags und die getrennten Source-, Anchor-,
Feed-PostgreSQL-, Redis- und Ed25519-Prüfungen bleiben verpflichtend.
Der bestehende One-Shot-Observer akzeptiert den signierten Export, indem er
_vor_ dem geplanten Feed-Abruf die SQL-High-Water-Funktion und danach den
Checkpoint aktualisiert. Das ist ein **persistierender, nicht atomar
zurückrollbarer Übergang über zwei Speicherbereiche**, kein reines
Diagnosekommando. Wenn der Canary anschließend am HTTPS, Parser, Redis
oder SQL-Lease scheitert, können Anker/Checkpoint schon auf 10/10 sein.
Bei unklarem Resultat deshalb **nicht erneut starten**, sondern getrennt
lesend SQL-High-Water, Checkpoint, Jobzustände und Leases untersuchen.

Der same-VPS-Anker teilt die VPS-/PostgreSQL-Backup-Domäne. Er ist keine
von einem kompromittierten oder komplett wiederhergestellten VPS unabhängige
Rollback-Sicherung.

## Zusätzliche operative Vorprüfung (noch NICHT autorisiert)

1. Den exakten neuen Main-SHA, sauberen VPS-Checkout, neu gebauten Worker,
   die signierte Inbox 10/10 und die alte 8/7-Checkpoint-/Anker-Kohärenz
   unabhängig prüfen, einschließlich der SHA-256-Digests und Trust-Policy-Revision.
2. Keine aktiven oder gestoppten P2-Prozesscontainer und kein konkurrierender
   Queue-Consumer/-Producer. Den Redis-Queue-Status und die historischen
   gescheiterten Jobs vorab nur lesend inventarisieren, nicht bereinigen.
3. Im PostgreSQL-Freigabenachweis die aktuelle `usgs_news`-Quelle und
   `www.usgs.gov`-Freigabe anhand der aktuellen persönlichen Audits bestätigen.
   Begründung und Nutzungsrechte gelten nur für Metadaten.
4. Den aktuellen USGS-Poll-Lease prüfen: kein künstliches Zurücksetzen,
   kein vorzeitiges erneutes Abrufen und keine Umgehung des Intervalls.
5. Operator autorisiert danach getrennt genau einen USGS-BullMQ-Job.
   Die bestehende 45-Sekunden-Antwortfrist, die signierte Quellenvalidierung,
   die Source-Guarded-Commits und die Metadatengrenze (max. 20 RSS-Items
   innerhalb der 128-KiB-Antwort) bleiben bestehen.
6. Nach dem Lauf Anker und Checkpoint getrennt prüfen, Persistenz,
   Projektor und Admin-Ansicht getrennt abnehmen. Erfolg des CLI allein
   bedeutet weder Veröffentlichung noch fertige P2-Phase.

Ein Testlauf kann wegen alter Poll-Leases keine neuen Kandidaten speichern.
Eine fehlgeschlagene HTTPS-Antwort, blockierter Article Scope oder deduplizierte
Einträge rechtfertigen keine Erweiterung der Quellrechte und keine
automatische Wiederholung.

Dieser Pull Request fügt **nur** die explizite USGS-Canary-Auswahl und
Abweisungstests hinzu. Keine Datenbankmigration, kein geänderter
Netzwerkmodus, kein automatisches Deployment und kein dauerhafter Scheduler.
