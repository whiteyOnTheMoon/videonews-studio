# P3-Demo – Synthetisches, tatsächlich abspielbares MP4

**Issue #476. Status: separater, nichtpublizierbarer CI-Funktionsnachweis.**
Dieser Schritt ist ausdrücklich **kein Live-Renderer, keine Benutzerfunktion
und keine Abnahme von P3-08/#33**.

## Durchgängige Testkette

Aus **zwei vollständig erfundenen Nachrichten-Metadatensätzen** mit
unterschiedlichen synthetischen Quell-IDs wird im vorhandenen P2-Worker:

1. Ein normalisierter Artikel-Datensatz erstellt.
2. Ein gleichnamiger Ereigniskandidat gruppiert und offline gerankt.
3. Ein deutschsprachiger, rein schematischer Nachrichtenentwurf erstellt.
4. Die redaktionelle Prüfung nachweislich **verweigert**
   (`approvedForPublication = false`, ungeprüfte Claims).
5. Ein Rechtebericht ohne echte Assets erstellt
   (`status = BLOCKED`, Render und Upload nicht freigegeben).

Der vorhandene P3-07-Generator verwandelt diese internen Daten in
**fünf tatsächlich erzeugte SVG-Szenen** mit sichtbarem Wasserzeichen:

- Titelseite und Erklärung
- Tabelle mit fiktiven Werten
- Zeitleiste mit fiktiven Vorgängen
- Balkendiagramm mit fiktiven Zahlen
- Schematische Karte ohne echte Geokoordinaten

`rsvg-convert` rastert **diese konkreten SVG-Bilder** zu internen PNG-Frames, die `ffmpeg` zu einem stummen
H.264-MP4 mit 1280 × 720 Pixeln, 8 Bildern/s und 10 Sekunden Dauer.
`ffprobe` prüft Codec, Laufzeit, Auflösung und 80 Videoframes. Somit
ist nicht nur ein Dateiname, sondern die tatsächliche Videodatei
technisch nachgewiesen. Die angezeigten Quellen-URLs enden auf
`example.org`; es erfolgt kein HTTP-Aufruf. Zwei IDs sind kein Beleg
zweier unabhängiger Verlage oder einer tatsächlichen Nachricht.

## Ausführungs- und Schutzgrenzen

Die CI-Datei `.github/workflows/p3-synthetic-mp4-demo.yml`
führt die Demo **nur auf dem kurzlebigen GitHub-Actions-Runner**
aus. Der Code lehnt Ausführung ohne `GITHUB_ACTIONS=true`
und `CI=true` sofort ab. Bestehende Node-/npm-Arbeitsbereiche
werden mit Lockfile gebaut. **Nur auf dem kurzlebigen CI-Runner**
werden die kostenlosen Ubuntu-Pakete `ffmpeg` und `librsvg2-bin`
installiert. Kein VPS-Systempaket wird verändert.

Der Encoder darf als Protokolle nur `file,pipe` lesen;
er verwendet `spawnSync` ohne Shell, ohne nutzergesteuerte
FFmpeg-Argumente oder untrusted SVG-Dateien. Er hat keine
Benutzer-, Admin-, Upload-, Cloud- oder Datenbank-Zugangsdaten.

Alle SVG-, PNG- und MP4-Dateien entstehen in einem privaten
System-Tempverzeichnis, werden auf Format/Sicherheit geprüft
und im `finally`-Block unmittelbar entfernt. Es wird **kein
GitHub-Artefakt hochgeladen**, nichts im Repository gespeichert
und keine Datei auf den VPS kopiert. CI führt zudem einen
Negativtest aus, der einen Aufruf außerhalb von Actions verweigert.

Die Demo importiert ausdrücklich die vorhandenen P2-/P3-Module.
Es handelt sich nicht um einen parallel neu erfundenen oder
aktivierten produktiven Medien-Workflow.

## Was für einen realen, nutzbaren Video-Prototypen noch fehlt

- Prüfung von **realen** redaktionellen Nachrichten, Claim-Evidenz
  und eine benannte menschliche Freigabe
- Konfigurierbare automatische Storyboard-Auswahl im Admin
- Tatsächliche Tonspur/Sprecherzeugung, Timing und Übergänge
- Sichere lizenzierte Medienaufnahme samt Downloads, SHA-256
  und unveränderlichen Lizenzbelegen
- Produktions-Renderer und Upload-Gates direkt an autorisierten
  API/Worker-Einstiegspunkten
- Wiederholbare E2E-Tests mit PostgreSQL/Redis und einer
  separaten, genehmigten Produktionsaktivierung

**Die Benennung „MP4-Funktionsnachweis“ bedeutet nicht
„P3 abgeschlossen“.** Keine zusätzliche Anbieterfreigabe,
keine neue Budgetbelastung, kein VPS-Neustart, keine
Datenbankmigration, kein externer API-Aufruf, keine Veröffentlichung.
Issue #32/#33 bleiben offen, bis ihre tatsächlichen Abnahmekriterien
erfüllt sind.
