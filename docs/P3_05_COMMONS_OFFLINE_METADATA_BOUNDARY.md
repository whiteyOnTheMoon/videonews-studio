# P3-05 – Wikimedia Commons: offline Lizenzmetadaten-Vorprüfung

**Status:** Teilumsetzung zu Issue #30, Stand 8. November 2026.
Dies ist ein deterministischer Parser für vorliegende, synthetische
MediaWiki-API-Daten. **Keine echte Commons-Datei wird heruntergeladen,
geprüft oder freigegeben. Issue #30 bleibt offen.**

## Primärquellen und Grenzen

- MediaWiki API imageinfo: https://www.mediawiki.org/wiki/API:Imageinfo
- CommonsMetadata/extmetadata:
  https://www.mediawiki.org/wiki/Extension:CommonsMetadata
- Commons-Nachnutzung:
  https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia
- Commons-Lizenzpolitik:
  https://commons.wikimedia.org/wiki/Commons:Licensing
- Creative-Commons-Attribution:
  https://creativecommons.org/reusing-cc-licensed-content/

`iiprop=extmetadata` liefert von Commons aufbereitete
Lizenz-/Urheberfelder und ist laut MediaWiki-Dokumentation teuer:
**nur wenige Dateien je API-Aufruf** abfragen. `Artist`, `Credit`
und andere Werte können HTML-Fragmente enthalten. Bei mehrfachen
Lizenzen können `LicenseShortName`, `LicenseUrl` und verwandte
automatische Felder unzuverlässig sein. Die Wikimedia Foundation
übernimmt keine Garantie für die korrekte Rechtslage einzelner
Medien; andere Rechte (Persönlichkeit, Marke, Eigentum) können
zusätzlich gelten.

## Umgesetzter Vertrag

`inspectOfflineCommonsImageInfo(input)` nimmt bereits bereitgestellte
`action=query&prop=imageinfo`-ähnliche JSON-Daten entgegen.

- Nur Dateien im Commons-Namensraum `File:` mit `ns=6`,
  eindeutiger Seiten-ID und passender Commons-Dateiseite.
- Höchstens zehn Dateien je Eingangsobjekt, atomare Ablehnung
  aller Kandidaten bei einer fehlerhaften Dateiseite.
- Nur konservativ akzeptierte Bitmap-Formate JPEG, PNG und WebP;
  kein SVG mit potenziell aktivem Inhalt, kein Video, kein GIF.
- HTTPS für öffentliche Commons-Dateiseite und offizielle
  Wikimedia-Upload-Referenz; **Download-URLs werden nicht
  zurückgegeben**.
- `CC0 1.0`, `CC BY 4.0` oder `CC BY-SA 4.0` nur, wenn
  `LicenseShortName` und **exakte offizielle Creative-Commons-URL**
  übereinstimmen. Nicht erkannte Versionen sowie NC, ND, mögliche
  Mehrfachlizenzen und `NonFree` werden gesperrt.
- Ein einfacher Klartext-Autor kann als **unbestätigter**
  Credit-Vorschlag mit Datei- und Lizenzlink übernommen werden.
  HTML-Formatierung, unbekannte Autoren oder eigene
  `Attribution`-Vorgaben führen zu einer gesperrten
  manuellen Prüfung, **nicht** zur improvisierten Credit-Zeile.
- Hinweise auf `Restrictions` und alle unbekannten
  Personen-/Markenrechte lösen ebenfalls eine manuelle Prüfung aus.
- CC BY-SA erhält einen separaten Hinweis zur Einzelprüfung.
  Änderungsstatus und Änderungs-Credit gelten als ungeklärt.

Der Parser vertraut keiner Behauptung einer Freigabe. Jeder
zurückgegebene Kandidat enthält `rightsStatus: blocked`,
`renderAllowed: false`, `uploadAllowed: false`,
`mediaDownloaded: false`, `licenseSnapshot: null` und
`contentSha256: null`. Er ist mit dem P3-02-Modul testbar
integriert: Auch ein formal gültiger Commons-Kandidat wird von
`precheckAssetLicense` als **BLOCKED** eingestuft.

## Noch offen für vollständiges P3-05

1. Zulässiger, sparsamer und authentifizierter Live-API-Zugriff mit
   Rate-Limits und API-Anbieterkennung; dieser PR enthält **keinen**.
2. Korrekte Behandlung komplexer HTML-Autor-/Lizenzdaten,
   Doppel-/Mehrfachlizenzen und der konkreten Urheberrechtslage
   durch benannte Personen, ohne riskantes HTML als Text auszugeben.
3. Sichere Dateibeschaffung, Inhalts-Hash aus tatsächlichen Bytes,
   Lizenz-Snapshot zum Downloadzeitpunkt und unveränderbare
   Speicherung im Asset-Katalog.
4. Vollständige TASL-Credits, Änderungen, ShareAlike-Prüfung,
   Persönlichkeits-/Markenrechte sowie redaktionelle Prüfung.
5. Echte Render-/Upload-Entry-Point-Sperre und End-to-End-Test
   mit synthetischen Test-Assets; kein produktives Video.

Die Tests simulieren ausschließlich API-Antworten und prüfen
CC0/BY/BY-SA, HTML-Autoren, eigene Creditpflichten, `Restrictions`,
NC/ND, unzulässige Lizenzen, URL-Spoofing, falsche Dateiverweise,
Mehrfachseiten und atomare Negativpfade. Keine Anbieter-Abfragen,
Secrets, neuen Kosten, Datenbankmigrationen, VPS-Befehle oder
Veröffentlichungen.
