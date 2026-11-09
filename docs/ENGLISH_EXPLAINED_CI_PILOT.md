# Earth & Climate Explained — erster englischer 8–10-Minuten-CI-Pilot

**Stand: 9. November 2026.** Bezug #480, PR #481; basiert auf der seit P3-07 bereits vorhandenen Offline-SVG-Funktion. Diese Datei beschreibt einen **rein technischen, nicht veröffentlichbaren** Proof of Concept und keine fertig freigegebene YouTube-Folge.

## Redaktionelles Format

Die verbindliche Struktur steht in [EXPLAINED_SCRIPT_STRUCTURE_V1.md](EXPLAINED_SCRIPT_STRUCTURE_V1.md): **The Hook → The Basics → What Happened? → Why Is It Happening? → Why It Matters → What's Next? → The Takeaway**. Abschnittszeiten sind _keine_ festen Werte. Der Generator muss langfristig inhaltlich sinnvoll mit dieser Reihenfolge arbeiten, statt Zeiten mit Standbildern aufzufüllen.

Die manuell kuratierte englische Episode `content/news/ozone-2026-explained-en.json` umfasst sieben originale englische Sprecherabschnitte (etwa 1264 Wörter) und 19 eigene grafische Visual-Beats. Alle Abschnitts- und Grafiktexte sind Englisch. Das Material basiert auf öffentlich dokumentierten Messungen vom November 2026 und erklärt:

- Was mit Ozonloch, Dobson-Einheit und Stratosphäre gemeint ist.
- Saisonmittel der Ozonlochfläche: **25 Mio. km²** (7. September bis 13. Oktober, 2026), Platz sieben in 48 Jahren (gemeinsame NASA-/NOAA-Auswertung).
- Tagesmaximum: **27,1 Mio. km²** am 18. September 2026; **kein** saisonaler Mittelwert.
- Südpol-Spaltenminimum: **105 DU** am 17. Oktober 2026, verglichen mit historischem Südpolminimum **92 DU** im Oktober 2006; **nicht** Flächenmessungen.
- Starker Polarwirbel als Hauptgrund für die ungewöhnliche Ausdehnung; langfristige Erholung unter dem Montrealer Protokoll.
- **Unterschiedliche Projektionen:** NASA/NOAA sprechen von den 2070ern; UNEP zitiert eine Einschätzung für etwa 2066 unter fortgesetzter Einhaltung der Abkommen. Beides sind Modellprojektionen, keine Jahresgarantie.

### Quellen / Beleggruppen

- [NOAA/NASA gemeinsame Auswertung, 4.11.2026](https://www.noaa.gov/news-release/noaa-nasa-release-measurements-of-2026-ozone-hole)
- [NASA Earth Observatory, 9.11.2026](https://science.nasa.gov/earth/earth-observatory/ozone-hole-reaches-its-2026-maximum/) – dieselbe US-Auswertung, **nicht als unabhängige zweite Prüfung zählen**.
- [Copernicus CAMS, 16.9.2026](https://atmosphere.copernicus.eu/copernicus-ozone-hole-reaches-notable-threshold-early-again-area-increases-above-average-2026) – eigenständige europäische Beobachtung, kein austauschbarer Messdatensatz.
- [DLR, 26.10.2026](https://www.dlr.de/en/eoc/latest/news/2026/ozone-hole-2026-one-of-the-largest-in-years) – TROPOMI/Sentinel-5P, keine Vermischung der instrumentabhängigen Tageswerte.
- [US EPA – Basiswissenschaft](https://www.epa.gov/ozone-layer-protection/basic-ozone-layer-science) – Chemie und UV-Schutz.
- [UNEP Ozone Secretariat – Fakten und Projektionen](https://ozone.unep.org/facts-and-figures-ozone-protection) – langfristige Prognosebedingungen.

Diese expliziten Quellenlinks sind **redaktionelle Verweise und offline im Manifest festgehalten**, aber der CI-Runner lädt keine Quellen ab. Ein separater unabhängiger Faktencheck, individuelle Freigabe, Aktualitätskontrolle und Prüfprotokolle bleiben erforderlich.

## Tatsächlich implementierter technischer Pfad (noch zu prüfen)

1. `assertEarthClimateExplainedStructure` erzwingt die sieben Abschnitts-IDs in der festgelegten Reihenfolge und die deklarierte Sprache `en-US`. Ein Sprachlabel ersetzt keine echte Sprach- und Inhaltsprüfung.
2. `buildNarrationTimeline` berechnet aus den **mit ffprobe gemessenen** Sprecher-WAV-Dauern und einer kurzen definierten Pause eine fortlaufende, 24-fps-genaue Timeline. Visual-Beats pro Abschnitt verteilen sich auf die tatsächlich verfügbare Zeit. Keine festen Abschnittsquoten.
3. `espeak-ng` erzeugt nur für die isolierte CI **eine kostenlose, deutlich als technisch minderwertig markierte Computerstimme**. Dies ist **keine** fertig ausgewählte professionelle Sprecherstimme. Der Run darf die Geschwindigkeit nur in einem begrenzten Bereich anpassen und akzeptiert ausschließlich eine tatsächlich gemessene 8–10-Minuten-Folge; ansonsten scheitert er.
4. Für jede Grafikeinblendung erstellt die vorhandene P3-07-Funktion eine eigene SVG-Datei, jetzt mit englischer Vorschau-Beschriftung; `rsvg-convert` erzeugt PNGs. Die Grafiken verwenden **keine fremden Bilder, NASA-Karten oder Drittanbieter-Videos**.
5. FFmpeg importiert die sieben **unkomprimierten** WAVs in eindeutiger Reihenfolge, normalisiert auf 48 kHz Mono, ergänzt **nur am Ende jedes Abschnitts** Stille, fügt sie zu **einer einzigen WAV-Tonspur** zusammen und kodiert die gesamte Episode **einmal** als AAC. Anders als der frühere deutsche Pilot gibt es **keine eigenständig AAC-komprimierten, aneinanderkopierten Sprecherszenen**.
6. Der isolierte Renderer legt 19 selbst erzeugte Bilder auf die gemessene Audio-Timeline und erstellt ein H.264/AAC-Preview mit 1280×720/24 fps. `ffprobe` prüft Codec, Streams, tatsächliche Dauer und Videoframes. Jede 8–10-Minuten-Abweichung wird abgelehnt.

## Qualitätsgrenzen

- **Noch keine echte Profi-Stimme:** eSpeak ist ausschließlich ein technischer Testersatz. Nächster P4-Schritt: zwei zulässige englische TTS-Stimmen/Provider anhand identischer Proben bewerten; Lizenz, Kosten und Genehmigung vor Einrichtung prüfen (#35/#36).
- **Noch keine vollständige YouTube-Videogestaltung:** 19 textbasierte Originalgrafiken sind besser als sieben statische Folien, aber keine finalen bewegten Satellitenbilder/Animationen. Für Serienqualität braucht es weitere Visual-Regeln und barrierefreie EN-Untertitel (#37–#42).
- **Noch kein produktiver Skriptgenerator:** diese eine englische Folge ist **redaktionell von Hand kuratiert**, nicht automatisch aus live eingespeisten Nachrichten generiert. Die eigentliche P2-Integration (#22/#23/#24) ist offen.
- **Noch keine Prüfung einer fertig hörbaren Datei durch die Redaktion:** Automatiktests können hörbare Artefakte, Aussprache und Dramaturgie nicht allein abnehmen.
- **Kein Garant für YouTube-Monetarisierung:** Länge, Eigenleistung, Rechte, Plattformregeln und Aufnahme ins Partnerprogramm sind getrennte Themen.

## Sicherheits- und Betriebsgrenzen

Der Workflow `.github/workflows/english-explained-offline-preview.yml` läuft nur auf einem kurzlebigen GitHub-Actions-Runner. Der Medien-Entrypoint verweigert alle Ausführungen ohne `GITHUB_ACTIONS=true` und `CI=true`. Quellen werden nicht live abgerufen und keine Bilder, Stimm-Modelle oder kostenpflichtigen API-Dienste heruntergeladen. Sämtliche SVG/PNG/WAV/MP4-Dateien verbleiben in einem privaten Runner-Temporärverzeichnis und werden selbst bei Fehlern im `finally` entfernt. Es gibt keine öffentliche Datei, GitHub-Medien-Artefakte, VPS-Migrationen, DB-/VPS-Änderungen oder Uploads.

Unverändert müssen gelten: `editorialApproved=false`, `rightsApproved=false`, `renderAllowed=false`, `uploadAllowed=false`, `publicationAllowed=false`. Der Film ist eine **nicht publizierbare Demonstration**, und der vorhandene P3-08-Deny-Only-Bericht bleibt `BLOCKED`.

## Abnahme

- [ ] CI-Workflow auf dem **konkreten finalen PR-Commit** erfolgreich: Build/Typecheck/Lint/Prettier/Tests, CI-Refusal-Test, echter 8–10-Minuten-H.264/AAC-Render, Dauer- und Frame-Abgleich.
- [ ] Tatsächliche englische Original-Narration und wissenschaftliche Aussagen menschlich geprüft.
- [ ] Sauber hörbare Sprechergliederung und vollständige Tonspur manuell geprüft.
- [ ] CI und unabhängiger Review oder eine ausschließlich für diesen PR dokumentierte Sonderfreigabe.
- [ ] Keine Rechte- und Publikationsfreigaben verändert.
