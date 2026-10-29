# P2-A: Prüfung realer offizieller RSS-Quellen und Quellenmodell

**Recherchedatum: 2026-10-29. Status: drei Vorschläge, keine Betreiberfreigabe,
kein Live-Abruf.** Vorhandene IONOS-Backups und Beszel sind bestätigt; an den
Produktionsdiensten wurde nichts verändert.

## Nachgewiesene Veröffentlichungs- und Feed-Referenzen

1. **NASA / Jet Propulsion Laboratory**, offizieller Nachrichten-RSS:
   https://www.jpl.nasa.gov/rss/ mit
   https://www.jpl.nasa.gov/feeds/news/ .
   NASA erlaubt grundsätzlich faktische redaktionelle Verwendung
   unter Quellenangabe und ohne suggerierte Unterstützung; geschützte
   Fremdmaterialien, Marken/Logos und bestimmte werbliche Nutzungen
   sind ausgenommen:
   https://www.nasa.gov/nasa-brand-center/images-and-media/ .
   Publisher-Gruppe `nasa`. **Vorläufig nur Metadaten / Links.**
2. **NOAA**, offizieller RSS-Index https://www.noaa.gov/rss-feeds
   mit dem von NOAA genannten allgemeinen Feed
   https://www.noaa.gov/rss.xml .
   NOAA erklärt, dass Bundesbehördenmaterial überwiegend frei nutzbar
   ist; Fremdmaterial, Quellencredits, keine falsche Amts- oder
   Produktempfehlung und KI-bedingte Bearbeitungshinweise müssen
   geprüft werden:
   https://www.noaa.gov/office-education/outreach-communication/faq .
   Publisher-Gruppe `noaa`. **Vorläufig nur Metadaten / Links.**
3. **USGS**, offizieller RSS-Link von der National-News-Seite
   https://www.usgs.gov/news/news-releases/national-news-releases
   auf https://www.usgs.gov/news/national-news-release/feed .
   USGS-eigene Inhalte sind gemeinfrei, Fremdmedien können geschützt
   sein, Quellenangabe wird verlangt:
   https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits .
   Publisher-Gruppe `usgs`. **Vorläufig nur Metadaten / Links.**

Die öffentlichen Nachweise erlauben keine automatische Feststellung,
dass **jeder** Beitrag, jeder Feed-Server oder jede kommerzielle Verwendung
genehmigt ist. Ein genauer Abruf-/Header-/Redirect-/XML-Test von den
vorgesehenen VPS-Quell-IP-Adressen sowie die dokumentierte persönliche
Freigabe von Quelle und Host stehen noch aus. Die Vorschläge werden
daher ausdrücklich **nicht** als `status: approved` in das Produkt
geschrieben. Beleg-Liste als maschinenlesbarer Bericht:
`docs/p2-a-official-source-candidates.json`.

## Kritischer Integrationsblocker (P2-01 bis P2-03)

Das derzeitige Produkt hat je Quellenregister-Eintrag **nur ein**
`baseUrl`. Dieses wird zugleich als **exakte HTTPS-Feed-URL** verwendet
(`apps/worker/src/feed-https-transport.ts`), muss mit `/` enden
(`apps/worker/src/source-registry.ts`) und begrenzt die URLs der im
Feed gefundenen **Artikel** auf denselben Präfix
(`apps/worker/src/feed-poller.ts`, `vns.project_approved_feed_candidates`).

Diese Annahme ist für reale Nachrichtensysteme nicht allgemein gültig:

- JPL liefert den offiziellen Feed unter `/feeds/news/`, Artikel
  können jedoch unter `/news/` erscheinen.
- NOAA nennt `/rss.xml`, das nicht mit `/` endet und nicht die
  URL-Präfixstruktur seiner Artikel abbildet.
- Der USGS-RSS-Endpunkt endet auf `/feed`; die Artikel liegen
  in anderen Bereichen des USGS-News-Portals.

**Weder ein künstlicher trailing slash noch das Eintragen des
Portal-Roots als RSS-Adresse ist eine sichere Lösung.** Das wäre
kein geprüfter Endpunkt und könnte den Rechte- und URL-Scope-Schutz
aufweichen oder alle Artikel verwerfen.

Vor der Live-Aktivierung ist deshalb eine **abwärtskompatible,
revisionsgesicherte Erweiterung** des Quellenvertrags erforderlich:

1. Getrennte, kanonische Felder `feedUrl` (exakter, öffentlicher
   HTTPS-RSS-Endpunkt) und `articleScope` (freigegebene kanonische
   Artikel-URL-Präfixe, hostgebunden und restriktiv) mit explizitem
   Source- und Host-Review. Eine Quellensignatur muss **beide** Felder
   abdecken.
2. Angepasste, atomare PostgreSQL-Quellenfreigaben und Projektions-
   Berechtigungen. Ein Kandidat außerhalb des aktuellen
   `articleScope` muss sofort abgelehnt werden. Keine generischen
   Redirects, Netzwerk-/DNS-Bypässe, offenen Host-Wildcards oder
   Selbstausstellung von Freigaben.
3. Einheitlich aktualisierte API-Validierung, Web-Formulare,
   Publisher/Signer, Producer, Consumer, Source-Authority,
   Feed-Poller, Projektion und Read-Only-Ranking. Alte Einträge
   müssen während einer Migration sicher und unverändert bleiben.
4. Wegwerfbares **echtes** Redis/PostgreSQL-E2E mit drei
   verschiedenartigen Host-/Feedpfaden; danach echte, ausdrücklich
   freigegebene Feed-Abrufe auf dem VPS.

`node scripts/p2_a_source_readiness.mjs --inspect` liefert deshalb
derzeit einen **absichtlich nicht-grünen** Status und eine begründete
Liste der fehlenden Rechte- und Modellschritte. Ein Nicht-Null-Exitcode
ist hier ein Sicherheitsnachweis, kein Fehler, der durch das
Ersetzen einer URL oder das Setzen einer Freigabe umgangen werden darf.

## Gewichtetes Ranking und P2-Abnahme

Der aktuelle persistierte SQL-Ranker aus Migration 0049 speichert
Keywords, Sperrlisten, Freshness und Quell-ID-Zählung. Es fehlen
eine **persönlich geprüfte** Zuordnung zur Eigentümer-/Publisher-Gruppe,
Quellenqualität und redaktionelle Risikoparameter sowie eine
belegte Unicode-NFKC-Parität zur TS-Offlinefunktion
`assessEditorialCandidate`. Eine identische Quell-ID kann
keinesfalls als unabhängiger Publisher- oder Claim-Beleg gelten.

Für die abschließende Abnahme muss die Pipeline deshalb sowohl die
separaten Quell-Scopes als auch **explizite**, revisionsgesicherte
Publisher-Provenienz und verifizierte Bewertungsparameter enthalten.
Ohne diese Inputs ist ein SQL-Score von 0049 nur ein
`metadata_candidate_only` und keine unabhängige Bewertung.

**Produktiver VPS:** Weder SSH noch eine nutzbare Admin-Session
stehen diesem GitHub-Integrationspfad zur Verfügung. Ein
GitHub-Merge bestätigt keine Installation der Migration 0049 oder
einen erfolgreichen Feed-Probeabruf auf dem VPS. Das gilt
unabhängig von den bestätigten IONOS-/Beszel-Backups.
