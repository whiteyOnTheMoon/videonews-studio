# P1-04 – Entscheidungsvorlage für einen internen VPS-Testbetrieb

**Status: Vorbereitung, keine Startfreigabe.** Stand: 23.10.2026. Kein VPS-Deployment, kein öffentliches Ingress, keine neuen Kosten. Diese Anweisung betrifft ausschließlich `/home/ap/www/videonews-studio` und das Compose-Projekt `videonews-studio`. Bestehende Container, Volumes, Tunnel, Ports und Netzwerke bleiben unangetastet.

## Aktuelle Ausgangslage (vom Betreiber gemessen)

| Merkmal | Wert |
| --- | --- |
| Laufende Container | 37 |
| Arbeitsspeicher | 7,8 GiB gesamt; 2,9 GiB verfügbar |
| Swap | 2,0 GiB gesamt; 1,4 GiB bereits belegt |
| Root-Dateisystem | 116 GB gesamt; 24 GB frei, 80 % belegt |
| Docker-Images | 371; Docker meldet 31,46 GB als freigebbar |
| Build-Cache | 1195 Einträge; Docker meldet 17,11 GB als freigebbar |
| Projektordner | vorhanden, zum Messzeitpunkt leer |

Die Docker-Freigabewerte sind **nicht additiv**. Ein `docker system prune`, `docker builder prune` oder Löschen fremder Images/Volumes ist untersagt, solange dafür keine gesonderte ausdrückliche Entscheidung getroffen wurde.

Cloudflared von Kurvenfunk ist an seinen jeweiligen Dev-/Staging-/Prod-Netzen angeschlossen. Weitere bestehende Dienste verwenden die Host-Ports 8081, 8083 und 8095. VideoNews Studio verwendet keinen davon.

## Architektur bis zur Authentifizierung

1. **Nur intern:** `web` und `api` sind das einzige mögliche Vorschauprofil. Ihre gemeinsam konfigurierten RAM-Obergrenzen liegen bei 832 MiB (640 + 192); reale Nutzung und Imagegröße müssen vor Ort beobachtet werden. Keinerlei `ports:`-, Host-Netzwerk- oder Tunnel-Verbindung.
2. **Keine Daten- oder Medienverarbeitung:** `postgres` und `redis` bleiben im Profil `data` deaktiviert. `worker` ist unter `worker` opt-in und beendet sich derzeit erwartungsgemäß sofort. Nicht als Dauerworker starten.
3. **Ingress abgeschaltet:** `caddy` ist intern nur HTTP auf 8080. Das ist **kein öffentliches HTTPS**, und die P1-04-Anforderung „HTTPS“ ist noch nicht erfüllt.
4. **Keine Admin-Sitzung:** Die Web-App ist aktuell ein Placeholder ohne Anmeldeschutz. Die spätere Admin-Authentifizierung (P1-06) ist vor jeder öffentlichen Freischaltung verpflichtend.
5. **TLS-Entscheidung nach P1-06:** Vorzugsweise einen *separaten* VideoNews-Studio-Tunnel beziehungsweise isolierten Ingress prüfen, ohne bestehende Cloudflare-Konfiguration oder andere Compose-Netze zu verändern. Ob Cloudflare TLS am Edge terminiert und HTTP über einen geschützten internen Pfad genutzt wird oder TLS bis zum Origin erforderlich ist, muss vorher explizit entschieden und getestet werden. Noch **keine Domain, Tunnel-Route, Zertifikatsverwaltung oder DNS-Änderung** beschließen.

## Freigabestufen

### Stufe A – ausschließlich Code/CI (bereits erreicht)

- [x] Compose-Sicherheitsprüfung und PR-Metadatenprüfung auf GitHub grün.
- [x] Docker-Images für Web, API und Worker auf **GitHub Actions**, nicht VPS, erfolgreich gebaut.
- [x] Interne Web-/API-Smoke-Tests auf dem GitHub-Runner unter Ressourcenlimits erfolgreich.
- [ ] Dokumentation, neues Preflight-Werkzeug und Tests aus PR #73 prüfen.

### Stufe B – VPS-Prüfung ohne Änderung (nächster möglicher Schritt)

- [ ] Code in getrenntes, bisher leeres Zielverzeichnis übernehmen **erst nach Entscheidung, wie Branch und Image-Artefakte freigegeben werden**.
- [ ] Das rein lesende Werkzeug `python3 scripts/preflight_vps.py --mode preview --path /home/ap/www/videonews-studio` aus einem *vertrauenswürdig geprüften Checkout* ausführen. Es startet nichts und prüft freien RAM/Platz, Swap und Compose-Projektnamenskollision.
- [ ] Betriebsüberwachung vorbereiten: `docker stats --no-stream`, `free -h`, `df -h`, `docker system df`, bestehende Dienstgesundheit. Nur lesen; keine Cleanup-Befehle.
- [ ] Falls ein Kriterium fehlschlägt: **kein Build/Start**; Optionen (kleineres Image, mehr Freiraum, anderer Build-Host) separat besprechen, nicht automatisch eingreifen.

### Stufe C – kontrollierter interner Probelauf (noch **nicht genehmigt**)

Voraussetzungen: Build-/Image-Beschaffungsstrategie geklärt, Stage B bestanden, neuer Baseline-Snapshot, Betreiberfreigabe für genau diese Container, kein Public-Ingress, PR-Review bzw. separat vereinbarte Ausnahme. Ein lokaler Docker-Build erfordert **strengere** Freiraum-Grenzwerte als eine reine Vorschau und ist momentan nicht freigegeben.

Erst dann darf ein konkreter Projekt-spezifischer Startplan mit expliziten Profilen und festgehaltenem Rollback ausgeführt werden. Keine implizite Freigabe durch diesen Text. `docker compose up -d` ohne Profil ist absichtlich leer; **niemals** `--profile data`, `--profile worker`, `--profile ingress` zum ersten Preview-Test aktivieren.

Erfolgsnachweise wären: Web und API healthy, keine Host-Ports, nur die eigenen Netze `videonews-studio_frontend/backend`, tatsächliche Limits/Verbrauch protokolliert, alte Dienste stabil. Rollback ausschließlich für das eigene Compose-Projekt; **keine** `down -v`, globalen Prunes oder Restart der Docker-Engine.

### Stufe D – späterer privater Produktionszugriff (blockiert)

Erst nach P1-06 (Authentifizierung), P1-07 (Queue/Sicherheitsprüfung), HTTPS-/Ingress-Nachweis und Betreiberfreigabe. Der externe Schutz (z. B. Cloudflare-Zugriffskontrolle) darf die serverseitige Anmeldung nicht ersetzen.

## Reproduzierbarkeit und offene Punkte

- `secrets/postgres_password` ist absichtlich nicht versioniert. Bei einem reinen Preview dürfen **keine echten Datenbank-Secrets erzeugt oder abgefragt** werden; eventuelle `docker compose config`-Validierung kann wegen der Datenprofil-Secret-Referenz dennoch eine Datei verlangen. Das wird vor einem Test gesondert und ohne Ausgabe des Passworts gelöst.
- GitHub Actions testet den isolierten Containerstart, aber keinen Compose-Start aller Profile auf dem VPS.
- Der Hoster hat keine laufenden automatisierten Backups; dieses Risiko ist bewusst vertagt. Persistente Volumes sind **keine** Backups.
- Die einmalige Betreiber-Ausnahme für die früheren PRs #70–#72 gilt **nicht** automatisch für PR #73.
