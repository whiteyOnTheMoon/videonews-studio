# P3-07 – Erster Beitrag mit echten Messdaten und deutschem Sprecherskript

**Stand: 9. November 2026. Bezug: #478, #32 und #33.**
Dieser Beitrag enthält **reale veröffentlichte wissenschaftliche
Messwerte**, keine erfundenen Nachrichten. Es ist eine **manuell
kuratierte Quelle-Snapshot-Redaktion**, keine produktive Live-Abfrage
und noch kein freigegebener Nachrichtenbeitrag.

Das Fakten- und Sprecherpaket liegt in
`content/news/ozone-2026-antarktis-de.json`.
Seine sieben `narration`-Texte sind das vollständig neu
formulierte deutsche Sprecherskript, nicht fremde
Artikeltexte. Die `sourceIds` zeigen zu jedem Bild auf die
konkreten Quellen.

## Öffentliche, recherchierte Belege

| Quelle | Datum | Inhalt und Rolle |
| --- | --- | --- |
| [NOAA](https://www.noaa.gov/news-release/noaa-nasa-release-measurements-of-2026-ozone-hole) | 04.11.2026 | Gemeinsame NASA/NOAA-Messauswertung: Saisonmittel 25 Mio. km² vom 07.09. bis 13.10., Platz 7 von 48 Jahren, Tagesmaximum 27,1 Mio. km² am 18.09.; 105 DU Südpolminimum 2026 und 92 DU im Oktober 2006 |
| [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/ozone-hole-reaches-its-2026-maximum/) | 09.11.2026 | Darstellung der Ozonloch-Ausdehnung und des Wetterzusammenhangs, teilweise dieselben Messungen wie NOAA |
| [Copernicus CAMS](https://atmosphere.copernicus.eu/copernicus-ozone-hole-reaches-notable-threshold-early-again-area-increases-above-average-2026) | 16.09.2026 | Unabhängige europäische Überwachung und Beobachtung überdurchschnittlich großer September-Fläche |
| [DLR](https://www.dlr.de/en/eoc/latest/news/2026/ozone-hole-2026-one-of-the-largest-in-years) | 26.10.2026 | Eigenständige europäische Satellitenanalyse sowie Kontext zum Polarwirbel und zur Größe/Tiefe |

**Wichtig:** NASA und NOAA beziehen sich auf eine gemeinsame
Analyse. Die beiden Webseiten sind **nicht** zwei unabhängig
verifizierte Nachrichtenquellen. Auch Copernicus/DLR verwenden
unterschiedliche Messreihen und Bezugsdaten; ihre Einzelwerte
werden nicht ungeprüft mit der NASA-/NOAA-Zeitreihe verrechnet.

## Originales deutsches Sprecherskript

1. **Einordnung:** Das Ozonloch über der Antarktis war 2026 ungewöhnlich groß. Trotzdem sprechen die Langzeitdaten weiter für eine Erholung der Ozonschicht.
2. **Saisonmittel:** NASA und NOAA melden für die Hauptphase vom siebten September bis zum dreizehnten Oktober eine durchschnittliche Fläche von rund fünfundzwanzig Millionen Quadratkilometern. Das ist Platz sieben seit Beginn der Messreihe.
3. **Tagesmaximum:** Am achtzehnten September erreichte das Ozonloch sein jährliches Flächenmaximum: siebenundzwanzig Komma eins Millionen Quadratkilometer. Diese Zahl beschreibt die Ausdehnung, nicht die gesamte Stärke des Ozonverlusts.
4. **Tiefe vs. Fläche:** Über dem Südpol lagen die niedrigsten gemessenen Ozonwerte am siebzehnten Oktober bei einhundertfünf Dobson-Einheiten. Im Oktober zweitausendsechs waren es nur zweiundneunzig. Groß heißt also nicht automatisch tief.
5. **Ursache:** Ein starker, lang anhaltender Polarwirbel begünstigte die Ausdünnung. Auch der europäische Copernicus-Dienst beobachtete im September eine überdurchschnittliche Ausdehnung.
6. **Langfristiger Ausblick:** Dass die Ozonschicht sich langfristig erholt, führen Forschende auch auf internationale Beschränkungen ozonschädlicher Stoffe zurück. Mit einer Rückkehr zu Werten von neunzehnhundertachtzig rechnen sie für die zweitausendsiebziger Jahre.
7. **Fazit:** Ein außergewöhnliches Jahr widerlegt keinen langfristigen Trend. Quellen: NASA, NOAA und Copernicus. Dies ist eine redaktionell noch nicht freigegebene Videovorschau.

Alle Zahlen haben im Datenobjekt eine eigene Kennung, Einheit
und mindestens einen Quellverweis. **25 Mio. km² ist eine
saisonale Durchschnittsfläche**, **27,1 Mio. km² ein Tagesmaximum**,
**105 und 92 Dobson-Einheiten sind zeitlich getrennte
Südpol-Minimalwerte**, **2070er ist eine Projektion**.

## Tatsächlicher Mediennachweis

`scripts/ci_p3_curated_real_news_video.mjs` prüft
das explizite Schema, Ursprungs-Hosts, Zeitpunkte,
die Kennzahlsemantik und die strikte Trennung von
NASA-/NOAA-Daten und europäischen Vergleichsbeobachtungen.

Die bereits vorhandene P3-07-Grafikfunktion erzeugt daraus
sieben neue eigenständige SVG-Folien. GitHub Actions
installiert auf einem **wegwerfbaren CI-Runner** kostenlose
Ubuntu-Pakete für SVG-Rasterisierung (`librsvg2-bin`),
deutsche Offline-Computerstimme (`espeak-ng`)
und H.264/AAC-Kodierung (`ffmpeg`). Es werden echte
SVG-, PNG-, WAV- und MP4-Dateien im privaten
Runner-Tempverzeichnis erzeugt und mit `ffprobe`
auf Video-/Audio-Codecs, Auflösung und Laufzeit getestet.
Danach löscht `finally` diese temporären Dateien.

Es gibt **keinen Medien-Download von NASA, NOAA, Copernicus
oder DLR**, keinen Bild-/Texttransfer aus Artikeln
und keine fremden Footage-, Karten- oder Stockmedien.
Nur die öffentlich belegten Zahlen und unabhängig
formulierten Beschreibungen werden genutzt.

## Unverändert gesperrte Rechte und Freigaben

Jeder Story-Datensatz enthält die literalen booleschen Werte:

- `editorialApproved = false`
- `rightsApproved = false`
- `renderAllowed = false`
- `uploadAllowed = false`
- `publicationAllowed = false`

Das CI-Skript ist **kein** Produktionsrenderer und
verweigert die Ausführung außerhalb von GitHub Actions.
Der vorhandene P3-08-Rechtebericht muss auf `BLOCKED`
stehen und jede Nutzung verweigern. Der explizite
`renderAllowed=false`-Wert wird durch eine rein
isolierte, nicht veröffentlichte **technische Demonstration**
nicht aufgehoben.

Für echten Betrieb fehlen weiterhin: automatisch autorisierte
Quellenaufnahme, unabhängiger redaktioneller Faktencheck,
benannte Freigabe im Admin, dauerhafte Lizenz-Snapshots
für zugelassene Medien und Sperren an echten Render-
und Upload-Einstiegspunkten. **Nicht auf dem VPS starten,
keine Produktionsmigration, keinen Upload auslösen,
Issue #33 nicht schließen.**

`main` bleibt bis zum genehmigten, überprüften Merge
unverändert. Das frühere Einverständnis für PR #470–#473
ist keine automatische Ausnahme für diesen neuen PR.
