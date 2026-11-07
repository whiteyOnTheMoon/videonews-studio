# P2-01 / P2-03 / P2-04: Quellenrechte und Herausgeber-Provenienz, Stand 2026-11-07

**Status: öffentliche Primärquellen recherchiert; kein persönliches Freigabe-Audit, keine neue Lizenz- oder Feed-Berechtigung.** Dieses Dokument ist eine Belegsammlung und Entscheidungsvorlage, ausdrücklich **keine** rechtliche Prüfung, Nutzungsrechtseinräumung oder produktive Quellenfreigabe. Die produktiven Source-/Host-Freigaben bestehen als gesonderter, signierter und persönlich auditierter Zustand.

## Echte PostgreSQL-Beobachtung am 07.11.2026

Die read-only Mehrquellen-Diagnose auf dem VPS bei exakt `a9e48a5ea92230930fe378889024c1eb35017d0d` ergab:

| Quellen-ID | Freigegebener Source-/Host-Snapshot | Persistierte Feed-Kandidaten | Projektierte Artikel / Ereignisse | Artikel innerhalb des Profil-Altersfensters | Persönlich gespeicherte Herausgeber-Provenienz |
| --- | --- | ---: | ---: | ---: | --- |
| `nasa_news` | ja / ja | 1 | 1 / 1 | 1 | **nein** |
| `noaa_news` | ja / ja | 10 | 10 / 10 | 0 | **nein** |
| `usgs_news` | ja / ja | 0 | 0 / 0 | 0 | **nein** |

Außerdem: `recent_distinct_source_ids=1`, `time_compatible_cross_source_pairs=0`, `shared_events=0`, `ranked_events=0`, `publication_violations=0`. Die aktuell wirksame redaktionelle Mindestzahl von zwei Quellen-IDs darf deshalb **nicht** für den NASA-Kandidaten abgesenkt werden. Das Diagnoseergebnis ist keine neue Betriebsgenehmigung.

## Offizielle Primärquellen für eine menschliche Rechteprüfung

### NASA / NASA-JPL

- NASA, [Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/): NASA-eigene Medien sind laut Richtlinie in den USA im Allgemeinen nicht urheberrechtlich geschützt und können für redaktionelle/informative Zwecke verwendet werden, **wenn** die jeweils einschlägigen Bedingungen eingehalten werden. Die Quelle nennen; keine amtliche Unterstützung/Empfehlung suggerieren. Bei NASA-Kennzeichen, identifizierbaren Personen und eingebetteten Materialien Dritter gelten zusätzliche Einschränkungen.
- NASA/JPL, [JPL Image Use Policy](https://www.jpl.nasa.gov/jpl-image-use-policy/): JPL weist ausdrücklich auf die unterschiedlichen Rechte von NASA, JPL-Caltech und weiteren Rechteinhabern hin. Nicht alle JPL- oder NASA-gekennzeichneten Bild-/Videomaterialien sind automatisch für jeden Zweck freigegeben; die jeweiligen Credits und Sonderfälle sind entscheidend.
- NASA, [Policy on Release of Information to News and Information Media](https://www.nasa.gov/reference/nasa-policy-on-the-release-of-information-to-news-and-information-media/): Veröffentlichung durch NASA ist eine offizielle Informationskommunikation der Agentur, **kein Beweis**, dass ein wiederverwendeter Artikel eine unabhängig recherchierte Zweitquelle darstellt.

**Vor Freigabe zu prüfen:** Hat ein NASA-Eintrag wirklich NASA als Ursprung oder ist es eine JPL-/Caltech-/Drittanbieter-Meldung? Stammen Zitat, Bild, Video oder englische Texte ganz/teilweise von Dritten? Gehört die **konkrete** RSS-Metadatenabfrage zum dokumentierten zulässigen Feed-Scope? Ein abgerufener Titel ist weder eine überprüfte Tatsachenbehauptung noch automatisch eine übertragene Medienlizenz.

### NOAA

- NOAA, [Education and Outreach FAQ](https://www.noaa.gov/office-education/outreach-communication/faq): NOAA weist darauf hin, dass auf NOAA-Websites auch Material **anderer** Urheber erscheint. Credits des **konkreten** Gegenstands kontrollieren; Quelle angeben; keine amtliche Partnerschaft suggerieren. Bearbeitungen und KI-generierte Änderungen dürfen nicht als originale Regierungsinformation ausgegeben werden.
- NOAA National Ocean Service, [Nutzung von Bildern und Grafiken](https://oceanservice.noaa.gov/about/faq.html): Die meisten amtlichen NOAA-Inhalte können bei korrekter Kennzeichnung verwendet werden. Besonders **Videos mit Drittmaterial** müssen einzeln geprüft werden.
- NOAA, [Science on a Sphere – Copyright Information](https://sos.noaa.gov/copyright/): Allgemeine NOAA-Nutzungsregeln sind getrennt von Rechten anderer ursprünglicher Schöpfer. Die SOS-Seite ist **keine pauschale Lizenz für alle Feeds auf noaa.gov**.

**Vor Freigabe zu prüfen:** Originale NOAA-Publikation oder übernommene Presse-/Partnerinformation? Gehört das neu betrachtete Artikelthema wirklich zum selben Ereignis wie ein anderer Artikel? Ein im NOAA-Feed älterer Artikel wird nicht durch eine neue Abrufzeit zu einem frischen Ereignis.

### USGS

- USGS, [Are USGS reports/publications copyrighted?](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted): Von USGS selbst erzeugte Daten und Informationen sind in den USA grundsätzlich gemeinfrei; USGS verlangt eine korrekte Quellenangabe. Material Dritter auf USGS-Seiten kann gesondert geschützt sein.
- USGS, [Copyrights and Credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits): Eigentums- und Credits-Hinweise pro Abbildung/Artikel beachten; Bild, Stimme und Persönlichkeit von Mitarbeitern können gesonderte Rechte berühren.
- USGS, [Acknowledging or Crediting USGS](https://www.usgs.gov/information-policies-and-instructions/acknowledging-or-crediting-usgs): Beispiele für Quellenangaben, keine Freigabe fremder urheberrechtlich geschützter Werke.

**Vor Freigabe zu prüfen:** Gehört der konkrete RSS-Eintrag zur Original-USGS-Mitteilung? Stimmen exakter Feed-Endpunkt, Scope und persönliche Host-Freigabe aktuell überein? Enthält eine Nachricht fremde Fotos oder widersprechende Nutzungshinweise?

## Drei voneinander unabhängige Prüfentscheidungen

1. **Recht zur Metadatenbeobachtung:** Exakter RSS-Endpunkt, Nutzungsbedingungen, Intervalle, Mengenlimits, Host-Audit, signierter Export und gegebenenfalls abweichende Drittbedingungen. Die aktuelle PostgreSQL-Freigabe ist eine technische Schranke, kein genereller Rechtstitel.
2. **Herausgeber-Herkunft und Unabhängigkeit:** Für **jede** Quelle aktuelle `source_revision`, Originalherausgeber, mögliche Syndikation, organisatorische Verbindung, unabhängige faktische Herkunft und die belegte, tatsächlich persönlich überprüfte `publisher_group` dokumentieren. Eine Quellen-ID ist nicht automatisch eine selbständige Herausgebergruppe; NASA/JPL-Caltech darf nicht unbesehen als unabhängig zur NASA-Pressemitteilung gezählt werden. Ebenso ist eine NOAA-News-Wiederveröffentlichung eines USGS-Berichts nicht automatisch unabhängige Bestätigung.
3. **Ereignis- und Claim-Verifikation:** Zwei zeitnahe Artikel sind nicht unbedingt dasselbe Ereignis; gleicher Wortlaut kann Syndikation sein. Echte Ereignisgleichheit und unabhängige inhaltliche Belege müssen vor redaktioneller Bewertung separat geprüft werden. Ein erfolgreicher Projektor-Lauf und eine errechnete Rankingzeile sind niemals Veröffentlichungsfreigaben.

## Persönlicher Review-Leitfaden – keine automatische Datenbankänderung

Vor dem Eintrag in die bestehenden persönlichen Admin-Formulare `editorial-publisher-review` / redaktionelle Metadatenprüfungen:

- [ ] Exakte `source_id`, aktuell signierte globale Quellenregisterrevision und exakte Host-/Feed-URLs getrennt prüfen. Bei neuer Revision aktuelle Freigaben neu nachweisen.
- [ ] Offizielle Nutzungs-/Credits-Seiten mit URL, Prüfdatum und unverändertem Dokument-Digest (außerhalb öffentlicher Chat-Logs) dokumentieren; pro Artikel auf fremde Rechte prüfen.
- [ ] Original-Herausgeber und eventuelle Nachrichtenübernahme/Syndikation unabhängig nachweisen. Bei Zweifel **keine** Unabhängigkeit attestieren.
- [ ] `publisher_group` erst nach menschlicher Prüfung vergeben; `quality` nicht aus RSS-Metadaten, Web-Domain oder Regierungsstatus automatisch ableiten.
- [ ] Persönliches aktives Editor-Login, aktuelle Registrierungsversion, immutable Review-Writer und getrennte Authentifizierungskontrollen verifizieren.
- [ ] Event-Bewertung (Erklärwert, Visualisierbarkeit, Risiko), Quellenvergleich, Sperrliste und tatsächliches Veröffentlichungsalter eigenständig prüfen.
- [ ] **Keine automatische Neubewertung, kein Quellen-GET, keine Projektor-Wiederholung und keine Publikation** durch den bloßen Abschluss eines Rechtechecks.

**Abnahmekriterium:** Für jede produktive Provenienzzeile ist persönlich nachvollziehbar, **wer** welche konkrete Primärquelle/Originalherkunft bei **welcher** Revision bewertet hat; die konkrete Quelle darf nicht ihren eigenen Status diktieren. Dieser Bericht stellt solche Review-Akte **nicht** selbst her.

## Unveränderte Betriebsgrenzen

Vier NASA-Canary-Container und sechs fehlgeschlagene/zwei abgeschlossene historische BullMQ-Jobs bleiben bestehen. Bei `awaiting_recent_multisource_input` sind neue Abrufe nur nach neuem, quellenspezifischem Operatorentscheid, aktuellem Signed-Source-/Host-/Poll-Lease-/Queue-Preflight und enger Runtime-Abgrenzung zulässig. Kein Checkpoint-Reset, keine erfundene zweitveröffentlichte Meldung, keine Lockerung der Mindestquellenzahl und kein erneutes Ausführen des bereits erfolgreichen NASA-DB-only-Projektors. Für einen Web-only-GHCR-Release bestehen eigene Budget- und ausdrückliche Betreiber-Gates; der Release ist nicht Bestandteil dieser Dokumentation.
