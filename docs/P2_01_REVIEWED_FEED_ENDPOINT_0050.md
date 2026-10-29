# P2-01: separater, geprüfter RSS-Endpunkt (Migration 0050)

## Daten- und Sicherheitsvertrag

Die Quelle besitzt weiterhin `baseUrl` als alleinigen freigegebenen
**Artikel-URL-Präfix**. Optional kann der persönlich authentifizierte
Quellenadministrator zusätzlich `feedUrl` als **exakte HTTPS-RSS-/Atom-
oder JSON-Abrufadresse** innerhalb desselben Hostnamens erfassen.

- Die API / Next.js-BFF / Admin-Oberfläche akzeptieren `feedUrl`
  ausschließlich in dem vorhandenen `create_pending`- bzw.
  `replace_pending`-Revisionsvertrag. Die gesonderte
  `approve`-Aktion und die zweite Hostfreigabe bleiben erforderlich.
- `baseUrl` darf nur eine kanonische HTTPS-Verzeichnisadresse mit
  abschließendem Schrägstrich enthalten; die Artikel-Links werden
  weiterhin ausschließlich gegen diesen Bereich und gesperrte
  Unterbereiche geprüft.
- `feedUrl` ist optional, muss jedoch ein kanonischer HTTPS-Endpunkt
  ohne Login, Query, Fragment, Encoding-Versteck oder abweichenden Host
  sein. Fehlt das Feld, bleibt die **historische Abrufsemantik**
  (`baseUrl` als exakte Feed-Adresse) unverändert.
- `vns.admin_commit_source_registry` und
  `vns.feed_runtime_source_authorized` werden in 0050 atomar erweitert:
  Zehn-Felder-Quellen werden nur mit zulässiger Feed-Adresse angenommen.
  Die Hostautorisierung bindet weiterhin das aktuelle
  Quellenregister und den aktuellen separat erteilten Host-Grant;
  bei jeder Änderung ist eine neue Freigabe nötig.
- Der signierte Quellenexport bindet auch `feedUrl` durch seine
  vollständigen serialisierten JSON-Bytes. Der Consumer vergleicht
  das **exakte** Feld mit dem geprüften Registry-Snapshot und verwendet
  ausschließlich den DNS-gepinnten, URL- und MIME-begrenzten Transport.
  Keine Redis-/Datenbank-/Signatur-Privilegien wurden ausgeweitet.
- Legacy-Quellen (9 Felder) bleiben gültig. Die 0050-Down-Migration
  verweigert bewusst den Rückbau, falls eine registrierte Quelle
  noch das 10. Feld `feedUrl` enthält, anstatt die Nutzungsrechte
  bzw. Abrufziele stillschweigend zu ändern.

## Quellen und Live-Freigabe

Drei **noch nicht persönlich freigegebene** Vorschläge stehen unter
`docs/p2-a-official-source-candidates.json`: NASA/JPL, NOAA und USGS.
Als künftige getrennte Felder kommen insbesondere in Betracht:

| Quelle | Artikelbereich (`baseUrl`) | Exakte Feed-Adresse (`feedUrl`) |
| --- | --- | --- |
| NASA/JPL | `https://www.jpl.nasa.gov/news/` | `https://www.jpl.nasa.gov/feeds/news/` |
| NOAA | `https://www.noaa.gov/` | `https://www.noaa.gov/rss.xml` |
| USGS | `https://www.usgs.gov/news/` | `https://www.usgs.gov/news/national-news-release/feed` |

Alle Angaben sind **technische Kandidaten**, keine Live-Konfiguration.
Pro Quelle sind echte Rückgabewerte, die Rechte am konkreten Artikel,
Quellen- und Hostreview und die Eignung des RSS-/Atom-Parsers erneut
zu prüfen. Es wird nur Metadaten-Erfassung und Quellenlinking
vorgesehen, kein Kopieren fremder Volltexte, Bilder oder Videos.

## Test- und Rollout-Grenzen

- Tests der API, BFF, React-UI, signierten Exportdatei, Transport-
  Zulassung und Artikel-Scope-Trennung.
- `db/tests/0050_reviewed_feed_endpoints.test.sql` prüft die
  neue Quellenversion gegen **echtes PostgreSQL**, einschließlich
  freigegebener Hostrevision, erfolgreicher Artikelprojektion und
  Ablehnung eines fremden Feedhosts.
- `db/scripts/test_migrations.sh` testet 0050 einschließlich
  Rückmigration auf der isolierten CI-Datenbank zweimal.
- Der VPS ist nicht automatisch aktualisiert. Vor Livebetrieb müssen
  Migration 0049 und 0050, neue Images, separat eingeschränkte Login-
  Rollen, Feed-Producer/Consumer/Projektor, Herkunftsfreigaben sowie
  der persönliche Admin-Lesepfad auf der realen Infrastruktur
  geprüft und ausdrücklich freigegeben werden.
- Noch nicht gleichwertig: gewichteter SQL-Ranker mit
  Publisher-Provenienz und Unicode-NFKC-Parität, unabhängige
  Claim-Verifikation, gesamte P2-Endabnahme.

IONOS-Backups und Beszel bleiben unangetastet.
