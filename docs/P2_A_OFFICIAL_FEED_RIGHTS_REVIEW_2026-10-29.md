# P2-A – geprüfte offizielle Feed-Kandidaten und Freigabeweg (2026-10-29)

**Ergebnis:** Drei offiziell gelistete RSS-Quellen sind mit dem seit Migration **0050** unterstützten **getrennten** `feedUrl`- und `baseUrl`-Vertrag strukturell kompatibel. **Keine** Quelle wird durch diese Dokumentation rechtlich oder administrativ genehmigt. Die tatsächlichen Feedantworten und die einzelnen Artikel-URLs müssen auf dem VPS geprüft werden.

## 1. Drei prüfbare Kandidaten

| Kandidat                  | Offiziell gelisteter RSS-Endpunkt                    | Artikel-`baseUrl`              | Nutzungsregeln                                                                    |
| ------------------------- | ---------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| NASA/JPL `nasa_jpl_news`  | https://www.jpl.nasa.gov/feeds/news/                 | https://www.jpl.nasa.gov/news/ | https://www.nasa.gov/nasa-brand-center/images-and-media/                          |
| NOAA `noaa_news`          | https://www.noaa.gov/rss.xml                         | https://www.noaa.gov/          | https://www.noaa.gov/office-education/outreach-communication/faq                  |
| USGS `usgs_national_news` | https://www.usgs.gov/news/national-news-release/feed | https://www.usgs.gov/news/     | https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits |

Offizielle RSS-Verzeichnisse: [JPL](https://www.jpl.nasa.gov/rss/), [NOAA](https://www.noaa.gov/rss-feeds), [USGS-Nachrichten](https://www.usgs.gov/news/news-releases/national-news-releases).

**NASA/JPL:** Die offizielle JPL-Liste benennt den News-Feed. Die NASA-Richtlinien gestatten die Verwendung eigenen Materials zu Informationszwecken unter Auflagen, einschließlich Quellenangabe, Ausschluss eines suggerierten NASA-Endorsements und besonderen Einschränkungen bei Marken, Bildern und Drittmaterial. Bei Bildern von Personen und kommerziellem Material können weitere Rechte berührt sein. Keine Logos, Bilder, Videos oder kompletten Artikel ohne Einzelprüfung übernehmen.

**NOAA:** NOAA bietet `rss.xml` ausdrücklich als Feed für die Website an. Laut NOAA sind eigene Inhalte im Regelfall gemeinfrei, **nicht jedoch automatisch sämtliches auf den Seiten dargestelltes Drittmaterial**. Quelle und NOAA-Programm nennen; keine behauptete staatliche Unterstützung. Umformulierte oder KI-bearbeitete Darstellungen als solche kennzeichnen, nicht als offizielle NOAA-Aussagen ausgeben.

**USGS:** USGS erklärt selbst erstellte Informationen grundsätzlich als gemeinfrei; fremde Bilder, Grafiken und andere Materialien können urheberrechtlich geschützt sein. Quellenangaben sind erwünscht. Der USGS-Identifikator ist markenrechtlich geschützt. Keine pauschale Nutzungsfreigabe aus einer RSS-Verlinkung ableiten.

**Gemeinsame Nutzungsbegrenzung für VideoNews Studio:** Zunächst ausschließlich **Metadaten** (Überschrift, kanonischer Link, Datum und Quellen-ID) für unveröffentlichte, redaktionell zu prüfende Kandidaten erfassen. Das ist **keine** Erlaubnis, den Volltext, Bilder, Audio, Videos, Logos oder Logos des Herausgebers zu übernehmen; für eine Veröffentlichung sind die konkrete Artikelherkunft, Drittanbieterrechte und faktische Aussagen unabhängig zu prüfen.

## 2. Umsetzung im Repository

Migration 0050 und `RegisteredResearchSource` erlauben einen expliziten `feedUrl`, der von `baseUrl` abweicht, sofern **beide dieselbe HTTPS-Hostidentität** besitzen und der Artikelpfad durch `baseUrl` abgedeckt ist. Das entspricht den drei oben aufgeführten Vorschlägen. Die frühere Source-Readiness-Prüfung erwartete irrtümlich, dass `feedUrl` selbst ein übergeordneter Verzeichnispfad sei; dieser veraltete Test ist korrigiert.

**Strukturell kompatibel heißt lediglich:** Die Quellenkonfiguration könnte nach allen separaten Freigaben im bestehenden Registry-Format gespeichert werden. Weder ein Discovery-Dokument noch `scripts/p2_a_source_readiness.mjs --inspect` vergeben Hostrechte, liefern Feedberechtigungen oder ändern die Datenbank. Die Quellenliste `docs/p2-a-official-source-candidates.json` bleibt mit `admission: pending_operator_review` und pro Quelle `rightsStatus: pending` unverändert.

## 3. Persönlicher Abnahmepfad – je Quelle separat

1. **Rechteprüfung dokumentieren:** Aktuelle Rechtequelle mit Datum archivieren/verlinken und für die konkret geplante Metadatennutzung die Urheberschaft und Drittmaterial-Ausnahmen einschätzen. Die Betreiberfreigabe muss persönlich und nachvollziehbar erfolgen. Ein allgemeiner „Public Domain“-Hinweis ist kein Beleg für die Rechte an jedem Feed-Element.
2. **Feed technisch lesen:** Vom VPS aus den **exakten** HTTPS-Endpunkt mit begrenztem Timeout, ohne automatische fremde Hostweiterleitungen, prüfen. HTTP-Status, Content-Type (RSS/Atom/XML), zulässige Hostzugehörigkeit und die kanonischen Item-URLs feststellen. Änderungen des Endpunkts oder Hostweiterleitungen **nicht automatisch** übernehmen.
3. **Quellenentwurf anlegen:** Im persönlich authentifizierten Admin den `baseUrl`-Artikelpfad, den separaten `feedUrl`, `usage: metadata_only`, `access: rss`, Abfrageintervall, Attribution, Rechte-URL und die konkreten Lizenznotizen zunächst als **pending** speichern.
4. **Unabhängige Hostprüfung:** Die für den Feed erforderlichen Hosts mit der bestehenden unabhängigen Hostrollenprüfung freigeben. Eine Quellenfreigabe allein ersetzt keine Hostfreigabe. Keine unkontrollierte Whitelist oder Freigabe per GitHub-Commit.
5. **Quelle persönlich genehmigen:** Nach nachvollziehbarer Rechts- und Feedprüfung die einzelne Quelle im Admin mit dem vorhandenen persönlichen Auditpfad auf **approved** setzen. Publisher-Gruppen/Qualität erst mit dem separaten persönlich geprüften Provenienzverfahren 0055 bewerten.
6. **Live-Abnahme durchführen:** Scheduler → Queue → Feedabruf → PostgreSQL-Kandidaten → Projektor → Deduplikation → gewichtetes Ranking → Admin-Anzeige über tatsächlich genehmigte Quellen testen. Fehlverhalten, Neustart, Widerruf und erneutes Einlesen einschließlich Log-/Audit-Nachweis prüfen.

## 4. Harte Grenzen

- **Drei Feed-URLs sind gefunden, nicht drei genehmigte Quellen.** Auch ein erfolgreiches CI-Ergebnis ist kein Beweis, dass die produktiven Feeds gegenwärtig erreichbar sind.
- Die im Web abrufbaren offiziellen Regeln sind die dokumentierte Ausgangslage, nicht die persönliche rechtliche Betriebsfreigabe.
- Die tatsächliche Feedantwort und die Item-Zielhosts wurden im Produktionsnetz **noch nicht verifiziert**.
- Bei Quellwechsel, geänderten Rechten oder Drittmaterialverdacht die Quelle erneut prüfen bzw. sperren. Jede Veröffentlichung bleibt gesondert gesperrt, bis die redaktionelle Prüfung abgeschlossen ist.
- IONOS-Backups und Beszel sind davon unabhängig und werden hier nicht erneut bewertet.
