# Earth & Climate Explained — verbindliche Skriptstruktur v1

**Entscheidung:** 2026-11-09. **Tracking:** #480. **Format:** `earth-climate-explained`. **Sprache:** `en-US`.

## Produktregel

Eine Episode erklärt **ein** aktuelles Thema zu Erde, Klima oder Umweltwissenschaft. Sie erzählt eine nachvollziehbare Geschichte für ein allgemein interessiertes Publikum, statt Nachrichten bloß vorzulesen. Alle sieben Abschnitte sind **Pflicht und in der folgenden Reihenfolge** zu liefern. Die Zeitfenster sind **redaktionelle Orientierungswerte für einen beispielhaften 9-Minuten-Film**, keine fest einprogrammierten Abschnittsdauern.

| Reihenfolge | Stabile Abschnitts-ID | Sichtbarer Titel | Unverbindliches Zeitfenster | Redaktionelle Funktion |
| --- | --- | --- | --- | --- |
| 1 | `hook` | The Hook | 0:00–0:20 | Überraschende belegte Tatsache oder spannende Leitfrage; Titel-/Thumbnail-Versprechen unmittelbar einlösen |
| 2 | `basics` | The Basics | 0:20–1:05 | Nötiges Vorwissen und neue Begriffe leicht verständlich erklären |
| 3 | `what-happened` | What Happened? | 1:05–3:30 | Die aktuellen Nachrichten, Beobachtungen und präzise benannten Messwerte |
| 4 | `why-is-it-happening` | Why Is It Happening? | 3:30–5:45 | Wissenschaftliche Mechanismen, Ursachen und Unsicherheiten |
| 5 | `why-it-matters` | Why It Matters | 5:45–7:30 | Auswirkungen, Relevanz und Einordnung; nicht mehr behaupten als die Quellen tragen |
| 6 | `whats-next` | What's Next? | 7:30–8:40 | Was Forschende erwarten; Prognosen, Grenzen und offene Fragen kennzeichnen |
| 7 | `takeaway` | The Takeaway | 8:40–9:00 | Eine klare Kernerkenntnis und ein kurzer Schluss ohne Wiederholungsfüller |

### Verbindlich vs. flexibel

- **Verbindlich:** sieben benannte Abschnitte, eindeutige IDs und Reihenfolge; englischer Text und später englische Stimme/Titel/Grafikbeschriftungen/Untertitel; sachlich korrekte, eigenständige Einordnung.
- **Flexibel:** Zeitaufteilung, Wortzahl je Abschnitt, Anzahl von Szenen/Visuals innerhalb eines Abschnitts und erzählerische Schwerpunkte. Die Grundlagen dürfen bei komplexen Themen etwas länger sein; es gibt **keine starren Sekunden- oder Prozentlimits pro Abschnitt**.
- **Laufzeit-Ziel der fertigen Folge:** 8:00–10:00 Minuten, Soll 9:00, bevorzugt 8:15–9:45. Erst das gemessene Audio, dann die visuelle Szenen-Timeline; keine inhaltsleeren Dehnungen.
- **Keine Titelfolien-Pflicht:** Der Hook beginnt unmittelbar. Werbe-/Monetarisierungslogik wird nicht in das journalistische Skript gemischt.
- **Wiederkehrende Struktur ist erlaubt, Inhalte nicht austauschbar:** Jede Episode braucht eine eigene Leitfrage, eigene wissenschaftliche Erkenntnisse und überprüfbare Quellen. Bei zu wenig belastbarer Substanz lieber keine Folge produzieren als künstlich verlängern.
- **Redaktioneller Belegstandard:** Zahlen mit Einheiten, Zeitbezug und Ursprung; Unabhängigkeit von Herausgebern nicht aus bloßer Quellenanzahl ableiten. Unsicherheiten und Projektionen sprachlich kenntlich machen. Keine Übernahme langer fremder Texte.
- **Abgrenzung:** Das geplante Multi-Story-Format `Earth & Climate News` hat ein **anderes** Skriptmuster. Diese sieben Abschnitte gelten für `Earth & Climate Explained`.

## Technischer Kontrakt und Integration

Der Shared-Baustein `packages/shared/src/explained-script-structure.ts` definiert die **stabilen Abschnitts-IDs und einen Offline-Validator**. Er überprüft `format`, deklarierte Sprache, vollständige Reihenfolge und nichtleere Sprechertexte. Er **setzt keine Abschnittsdauern fest** und kann weder die tatsächliche natürliche Sprache noch den Wahrheitsgehalt automatisch bestätigen.

**Wichtig:** Dieser Kontrakt wird mit der vorliegenden Änderung noch **nicht** in einen produktiven Skriptgenerator, Admin, Renderer oder Uploader eingebunden. Vor einer aktiven Pipeline muss die Integration in #22 (Skriptgenerator), #23 (redaktionelle Prüfung), #24 (Profilkonfiguration), #34 (Szenen-Timeline), #35/#36 (TTS) und #37 (Untertitel) erfolgen, jeweils mit passenden Integrations- und Negativtests.

## Abnahme für die spätere Generatorintegration

1. Der Generator liefert genau diese sieben IDs in dieser Reihenfolge; fehlende, doppelte oder vertauschte IDs blockieren den Entwurf.
2. Das konfigurierte Ausgabeformat und die Sprache stimmen; die **tatsächliche** Sprache von Skript und Rendering wird gesondert geprüft (ein `en-US`-Feld allein genügt nicht).
3. Abschnittslängen sind durch Inhalt, Sprecher-Timing und fachliche Dramaturgie flexibel; keine festen Dauern im Schema.
4. Faktische Aussagen sind quellengebunden; eine getrennte Prüfung kann unbelegte Behauptungen zurückweisen.
5. Die fertige 8–10-Minuten-Folge besteht Audio-/Video- und Quellen-QA und bleibt bis zur expliziten Freigabe **nicht veröffentlichbar**.

## Sicherheit und Freigaben

Reiner Offline-/CI-Kontrakt. Keine VPS-Änderung, keine neuen Providerkosten, keine Medien-Downloads, keine DB-Migration, kein Live-Rendering, kein Upload und keine Veröffentlichungsfreigabe. Bestehende Fail-Closed- und Editorial-Review-Gates bleiben unverändert.
