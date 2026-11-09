# P3-07 – Eigene Grafiken statt fremdem Footage (offline)

Bezieht sich auf Issue #32. Dies ist ein funktionsfähiger, bewusst
**nicht publizierbarer** Grafik-Fallback und noch keine vollständige
Storyboard- oder Produktionsfreigabe.

## Funktion

Die exportierte Funktion `makeOfflineGraphicStoryboard(input)` erzeugt
aus expliziten, begrenzten Text- und Zahlenfeldern wirkliche
1280×720-SVG-Bilder – vollständig deterministisch und ohne Netzwerkzugriff.

Unterstützte Szenen:

- **Textkarte** – Überschrift und umbrochener Nachrichtentext.
- **Tabelle** – zwei Spalten und zwei bis sechs Zeilen.
- **Zeitleiste** – zwei bis fünf beschriftete Ereignisse.
- **Balkendiagramm** – zwei bis sechs nichtnegative, endliche Werte.
- **Schematische Karte** – ein bis sechs frei übergebene Normpunkte
  (0–100 für x und y), **keine geografisch präzisen Koordinaten,
  Landesgrenzen oder Kartenkacheln**.

Jede Szene verlangt 1–3 formal gültige, eindeutige HTTPS-Quellenverweise.
Diese Links werden weder abgerufen noch inhaltlich geprüft. Die
Visualisierung führt daher die Anzahl mit dem Vermerk „ungeprüft“ auf.
Inhaltliche Verifikation, echter Quellenschutz und redaktionelle
Bewertung müssen in den anderen Phasen stattfinden.

Die SVG-Ausgabe enthält nur fest vorgegebene geometrische Elemente und
XML-maskierten Text, niemals `<image>`, `<script>`, `<foreignObject>`,
Remote-Bilder, Links, Webfonts oder nutzergeliefertes SVG-Markup.
Ungültige Szenen blockieren **atomar die gesamte Vorschau** statt einen
teilweise irreführenden Storyboard-Export zu erzeugen.

## Sicherheitsstatus

Jede gültige Vorschau trägt ein sichtbares Wasserzeichen
„VORSCHAU – NICHT ZUR VERÖFFENTLICHUNG“.

Der Rückgabewert enthält immer `videoRenderAllowed: false`,
`uploadAllowed: false` und `sourcesVerified: false`. Das gilt selbst
dann, wenn der Aufrufer gefälschte `publisherApproved`- oder
`uploadAllowed`-Felder übergibt. Die Funktion erzeugt **nur einzelne
SVG-Vorschaubilder**, kein Video und keinen Publikationsdatensatz.

## Reproduzierbarer Integrationsnachweis

Der PR-Workflow `p3-07-offline-graphics.yml` kompiliert das
Shared-Paket, führt Validierungs- und Injection-Negativtests aus und
schreibt fünf SVG-Szenen **ausschließlich in ein temporäres Verzeichnis
des isolierten GitHub-Runners**. Anschließend werden sie wieder
verworfen. Das CI-Skript verweigert die Ausführung außerhalb von
GitHub Actions; auf dem VPS ist dafür kein Befehl erforderlich.

Es gibt keine Grafik-API, keine externen Downloads, keine bezahlten
Modelle, keine fremden Medien, keine neuen Datenbankrechte und keine
produktive Render-/Upload-Funktion.

## Bewusst offene Abnahme-Punkte

- P2-09 / #24 (Nischenprofil und Sprachen) ist noch offen. Bis dahin
  besteht keine profilgesteuerte automatische Storyboard-Auswahl.
- P3-01 / #26 Asset-Katalog ist separat als PR #470 vorbereitet.
  Die Grafik-Vorschau schreibt deshalb keine realen Asset-Einträge.
- Die echte Render-/Upload-Sperre an zukünftigen Laufzeit-Endpunkten
  bleibt P3-08 / #33. Ein SVG-Vorschaubild ist keine Freigabe.
- Für visuelle Produktionsfreigabe fehlen die redaktionelle
  Inhaltsprüfung, Barrierefreiheits-/Layout-Abnahme und eine
  integrierte persönliche Admin-Vorschau.
- Externe Quellen-Adapter P3-03 bis P3-06 sind hiervon unabhängig
  und noch nicht umgesetzt.

**Issue #32 nicht als vollständig abgeschlossen kennzeichnen**, solange
diese Integrationen und ein unabhängiger Review fehlen. Der separate
PR erfüllt die reproduzierbare Offline-Rendering-Grundlage.
