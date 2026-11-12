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

| Quelle                                                                                                                                            | Datum      | Inhalt und Rolle                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NOAA](https://www.noaa.gov/news-release/noaa-nasa-release-measurements-of-2026-ozone-hole)                                                       | 04.11.2026 | Gemeinsame NASA/NOAA-Messauswertung: Saisonmittel 25 Mio. km² vom 07.09. bis 13.10., Platz 7 von 48 Jahren, Tagesmaximum 27,1 Mio. km² am 18.09.; 105 DU Südpolminimum 2026 und 92 DU im Oktober 2006 |
| [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/ozone-hole-reaches-its-2026-maximum/)                                   | 09.11.2026 | Darstellung der Ozonloch-Ausdehnung und des Wetterzusammenhangs, teilweise dieselben Messungen wie NOAA                                                                                               |
| [Copernicus CAMS](https://atmosphere.copernicus.eu/copernicus-ozone-hole-reaches-notable-threshold-early-again-area-increases-above-average-2026) | 16.09.2026 | Unabhängige europäische Überwachung und Beobachtung überdurchschnittlich großer September-Fläche                                                                                                      |
| [DLR](https://www.dlr.de/en/eoc/latest/news/2026/ozone-hole-2026-one-of-the-largest-in-years)                                                     | 26.10.2026 | Eigenständige europäische Satellitenanalyse sowie Kontext zum Polarwirbel und zur Größe/Tiefe                                                                                                         |

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
und Upload-Einstiegspunkten. **Keine Produktionsmigration oder Upload auslösen,
Issue #33 nicht schließen.** Eine explizite lokale Vorschau
ist nur mit `--save-local` als Benutzer `ap` vorgesehen.

`main` bleibt bis zum genehmigten, überprüften Merge
unverändert. Das frühere Einverständnis für PR #470–#473
ist keine automatische Ausnahme für diesen neuen PR.

## Private lokale MP4-Vorschau (kein Upload)

Optional für den Hobbybetrieb, **nur zur privaten Wiedergabe**: Nach
Installation der lokalen Programme `node`, `ffmpeg`, `ffprobe`,
`rsvg-convert` und `espeak-ng` sowie mit installierten Node-Abhängigkeiten
und gebautem `@vns/shared`-Paket kann der Nutzer `ap` auf dem VPS im
sauberen Repository eine lokale Vorschau rendern:

```bash
node scripts/ci_p3_curated_real_news_video.mjs --save-local
```

Die Datei entsteht ausschließlich unter
`/home/ap/vns-offline-previews/ozonloch-2026-de-vorschau.mp4`, außerhalb
des Git-Verzeichnisses und der öffentlichen Webverzeichnisse. Das Zielverzeichnis
hat Modus `0700`, die Datei `0600`. Bereits vorhandene Vorschauen werden
nicht überschrieben. Die sieben Originalgrafiken und die deutsche Offline-Stimme
sind dieselben wie im CI-Nachweis. Es gibt keinen Datenbank-/Redis-Zugriff,
keine Live-Nachrichtenabfrage, keinen Medien-Upload und keine Veröffentlichung.

Zum privaten Herunterladen vom eigenen Computer kann eine bestehende
SSH-Verbindung mit `scp` genutzt werden. Dabei wird die Datei **nur**
zwischen dem VPS und dem eigenen Computer kopiert; nichts wird öffentlich
freigegeben. Die nötigen Pakete werden nicht automatisch installiert und
der normale CI-Aufruf erzeugt weiterhin keinerlei dauerhafte MP4.

Die Vorschau ist ein Demo-Video zu den festen, manuell kuratierten
November-2026-Daten. Sie ist weder ein laufender News-Generator noch eine
Freigabe für automatische Publikation.
