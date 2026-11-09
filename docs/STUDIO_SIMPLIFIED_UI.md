# Studio UI – vereinfachte private Bedienung (P4-10, #483)

**Stand: 2026-11-09, nur GitHub-Entwicklung. Kein VPS-Deploy.**

Unter `https://studio.ap-pixels.com/admin` soll der angemeldete Betreiber künftig hauptsächlich zwei Schaltflächen vorfinden: **News recherchieren** und **Video erstellen**. Die lange bisherige Adminansicht ist in die Reiter **Erstellen**, **Videos**, **Einstellungen** aufgeteilt.

## Aktueller Stand der Umsetzung im Branch #481

- **Erstellen:** Kuratierten Ozonloch-Piloten auswählen oder vorhandene Feed-Metadaten aus der bestehenden persönlichen Inbox laden. Andere Inbox-Meldungen werden als noch ungeprüfte Kandidaten angezeigt. Der große Button **Video erstellen** ist ausschließlich für das bereits manuell vorbereitete englische Pilotmanuskript vorgesehen. Er wird nur nach gesondertem, zunächst abgeschaltetem VPS-Feature-Gate aktiviert.
- **News recherchieren:** In dieser **ersten Stufe** ist das eine read-only Abfrage bereits gespeicherter Nachrichteneinträge, **keine neue Live-Recherche und kein RSS-Run**. UI nennt die Einschränkung ausdrücklich. Ein Live-Abruf gehört zu einer späteren gesondert genehmigten Anbindung des P2-Feed-Workers inklusive Quellengates und Statusmeldung.
- **Videos:** Nach aktiviertem privaten VPS-Preview-Backend sieht der persönlich authentifizierte Betreiber die gespeicherten MP4-Dateien, einen HTML5-Player, die Renderstatusmeldung und einen Downloadlink am selben Ursprung. Keine statische, öffentliche `/uploads`-URL und kein YouTube-Upload.
- **Einstellungen:** Bestehende Editor-Anmeldung, Rechercheauftrags-Vormerkung, Quellen-, Ranking-, Provider- und redaktionelle Prüfbereiche bleiben erhalten, aber sind nicht mehr im Hauptbild.
- **Keine stillen Freigaben:** Das rote Original-Preview-Watermark bleibt in allen MP4-Grafiken erhalten; Render/Upload/Publikation sind **keine** redaktionelle Freigabe.

## Neue API-Sicherheitsgrenzen

Der Web-BFF hat folgende Routen. Alle sind standardmäßig `404` und benötigen die bisherige gültige **Admin-Sitzung plus aktive persönliche Admin-Editor-Sitzung**, deren Zustand serverseitig wieder geprüft wird.

| Route | Zweck |
| --- | --- |
| `GET /api/admin/private-previews` | Liste der privaten MP4s |
| `GET /api/admin/private-previews/status` | VPS-Renderstatus im API-Prozess |
| `POST /api/admin/private-previews/render` | Einzelnen Ozonloch-Preview-Auftrag starten; zusätzlich exakte Same-Origin-CSRF-Prüfung |
| `GET /api/admin/private-previews/[file]` | Privat streamen, Byte-Range für HTML5-Video |
| `GET /api/admin/private-previews/[file]?download=1` | Authentifizierter Download mit `Content-Disposition: attachment` |

Der API-Dienst kann nach separatem explizitem Operator-Opt-in `/admin/private-previews` bedienen. Der lokale Speicherpfad **`/home/ap/videonews-previews`** ist fest vorgegeben und liegt außerhalb `www`. Filename-Allowlist, `O_NOFOLLOW`, Eigentümer-/Dateiberechtigungen, maximale Dateigröße, `private, no-store`, `nosniff` und Browser-Same-Origin werden geprüft. Stream- und Downloadzugriff werden bei jedem Request erneut authorisiert; lediglich ausgewählte Header werden im BFF weitergereicht.

Ein VPS-Render nutzt nur den **fest verdrahteten** `ozone-2026-explained-en`-Pilot, den bereits vorhandenen streng begrenzten lokalen Renderer und kein durch die UI übergebenes Shellkommando. Ein einzelner Auftrag gleichzeitig, Mindestabstand zwischen Starts, keine Hintergrund-Feed-Veröffentlichung. Die Sprachtechnik bleibt ein technischer eSpeak-Platzhalter. Der Renderjobzustand ist **nur im API-Prozess gehalten** und nach einem Neustart nicht persistent; bereits erzeugte MP4s bleiben auf Platte. Diese Einschränkung muss für eine spätere Produktions-Queue behoben werden.

### Default-off Konfiguration – keine automatische Aktivierung
- `VNS_PRIVATE_PREVIEWS_API_ENABLED=true`: API-Studio-Videodienst überhaupt erst injizieren (benötigt Editor-Auth und Admin-Auth).
- `VNS_PRIVATE_PREVIEWS_ROOT=/home/ap/videonews-previews`: exakt erwartetes privates Verzeichnis; darf kein Symlink sein; Verzeichnisberechtigung `0700`, Videodateien `0600`.
- `VNS_PRIVATE_PREVIEWS_RENDER_ENABLED=true`: Renderbutton im API nur, wenn der Prozess als VPS-Benutzer `ap` läuft und die lokalen Medienwerkzeuge bereits geprüft sind.
- `VNS_WEB_PRIVATE_PREVIEWS_ENABLED=true`: Web-BFF für Liste, Video, Download und Status einschalten; persönliche Editor-Auth muss ebenfalls freigegeben sein.
- `VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED=true`: Web-BFF-Startbutton einschalten; Standard ist OFF.

**Wichtig:** Diese Variablen werden **nicht** durch das Hinzufügen der Dateien gesetzt. Vor Aktivierung muss die tatsächliche Serverarchitektur geprüft werden: Die bislang vorgesehenen Docker-Container laufen nicht zwingend als `ap`, besitzen keine Berechtigung auf `0700`-Ordner außerhalb des Webroots und enthalten nicht zwingend `ffmpeg`, `rsvg-convert` oder `espeak-ng`. Unabgestimmte Mounts, `sudo`, Ports, Ingress-Änderungen oder Privilegieneskalation sind verboten. Der Betreiber braucht einen genehmigten kleinen eigenen `ap`-Renderprozess oder ein entsprechend abgesichertes Laufzeitsetup, bevor der Startknopf tatsächlich freigegeben werden kann.

Auch die Behauptung, `studio.ap-pixels.com` sei „nur für mich ersichtlich“, muss **am bestehenden TLS-/Ingress-/Auth-Setup überprüft** werden. Die Anwendung darf nicht als öffentlich lesbare Medienroute freigeschaltet werden. Die zusätzliche Editor-Sitzung ist momentan in den Einstellungen zugänglich; eine gemeinsame, einfache Single-Sign-On-Oberfläche wird später separat umgesetzt, ohne die Personalisierung der Freigaben zu schwächen.

## Abnahme
- [ ] PR-CI Build/Tests/TypeScript/Lint/Prettier bestanden
- [ ] Sicherheitstests: kein Zugriff ohne gültige Rollen, kein Pfad-Traversal/irregulärer MIME-Typ, keine ungeprüfte Fremd-News-Renderfreigabe, keine öffentliche URL
- [ ] Unabhängiger Review / ausdrücklich PR-spezifisch freigegebene Ausnahme dokumentiert
- [ ] VPS-Inventur und korrekte Prozessrechte/Mounts/Tools geprüft
- [ ] Authentifizierte Listung und HTTP-Range-Playback auf `studio.ap-pixels.com` tatsächlich getestet
- [ ] Ein vom Betreiber genehmigtes Ozonloch-Video **auf VPS** erfolgreich gerendert, gespeichert, gespielt und heruntergeladen
- [ ] Professionelle TTS und redaktionelle Freigaben separat – kein Public Upload

**Konsequenz:** Ein funktionierender GitHub-Code-PR ist noch **kein** deployed Video-Studio und kein Beleg eines auf dem VPS erzeugten Videos. Ein direkter `sandbox:/mnt/data`-Chatlink setzt eine tatsächlich hierher übertragene MP4-Datei voraus.
