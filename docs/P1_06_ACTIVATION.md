# P1-06 – Admin-Login: Aktivierungs- und Abnahmeplan

Status: **Vorbereitung / keine Aktivierungsfreigabe**. Gilt für den separaten VideoNews-Studio-Docker-Stack.

## Ist-Zustand (23.10.2026)

Der Betreiber hat die öffentliche Vorschau über `https://studio.ap-pixels.com` hinter Cloudflare Access erfolgreich getestet. Web und API sind healthy und über das interne Docker-Netzwerk erreichbar. Der API-Healthcheck lautet `/healthz`. Der laufende Preview-Stack besteht aus Web, API und cloudflared; PostgreSQL ist bisher **nicht aktiviert**.

Das derzeitige `compose.yaml` setzt die Opt-in-Authentifizierungsvariablen **nicht**. Cloudflare Access ist eine zusätzliche äußere Zugangssperre und ersetzt die Anwendungsauthentifizierung nicht.

Der GitHub-Code enthält bereits:
- API-Admin-Login mit gesalzenem scrypt-Passworthash, zeitlich begrenzten Sessions, Origin-Prüfung, Ratelimit und sicherem Cookie.
- Next.js-Serverrouten als internes Backend-for-Frontend sowie einen serverseitig geschützten Adminbereich.
- Automatisierte API-/Webtests. Vor Aktivierung müssen die aktuellen CI-Ergebnisse für den Deploy-Commit neu kontrolliert werden.

## Prüfpunkte vor einer Aktivierung

1. Aktuellen Build und die exakten GHCR-Image-Digests bestimmen; keine zufälligen `latest`-Images deployen.
2. `VNS_ADMIN_ORIGIN` muss **exakt** `https://studio.ap-pixels.com` lauten; `VNS_API_INTERNAL_URL` muss nur serverseitig auf `http://api:4000` zeigen.
3. Nur nach ausdrücklicher Betreiberfreigabe: `VNS_WEB_ADMIN_ENABLED=true` auf Web und `VNS_ADMIN_AUTH_ENABLED=true` auf API setzen. Fehlende oder falsche API-Konfiguration muss fail-closed bleiben.
4. Admin-Passwort und Hash ausschließlich auf dem VPS über eine dafür vorgesehene, geschützte Secret-Datei oder ein gleichwertiges Verfahren bereitstellen; **keine** Werte in Git, `docker compose config`-Ausgaben, Shell-History, Chat oder CI-Logs ausgeben. Vorher prüfen, wie diese Werte ohne Klartext in Docker-Umgebungsvariablen übergeben werden. Die aktuelle API liest `VNS_ADMIN_PASSWORD_HASH` aus `process.env`, nicht aus `*_FILE`.
5. Kein neuer öffentlicher Host-Port, keine Änderung anderer Cloudflare-Tunnel, kein automatischer Upload.
6. Erst nach Review und genehmigter Umstellung die neuen Web-/API-Images neu starten. Rollback auf exakt die zuvor eingesetzten Digests vorbereiten.
7. Den wirklichen öffentlichen Pfad nach Cloudflare Access testen: Auth-Endpunkte nur über die Web-BFF-Routen, Adminseite ohne Session nicht zugänglich, Session-Cookie sicher, falscher Origin abgelehnt, Logout wirksam, Ratelimit vorhanden, keine Secret-Leaks. Separat prüfen, ob der API-Dienst unerwartet öffentlich erreichbar ist.
8. Prüfen, ob der externe Cloudflare-Login und der interne Admin-Login gemeinsam ohne Redirect-/Cookie-Probleme funktionieren; Ergebnisse ohne Cookies oder Passwörter protokollieren.

## Noch offene Risiken

- Session- und Ratelimit-Zustände sind rein in-memory; API-Neustart beendet aktive Sitzungen.
- Das derzeitige Admin-Hash-Interface ist eine Umgebungsvariable. Vor Deployment prüfen, ob ein Datei-basiertes Secret-Interface erforderlich ist; Secret-Inhalte dürfen niemals in Versionierung oder Logs gelangen.
- Cloudflare Access schützt die Vorschau, garantiert aber nicht die Autorisierung zukünftiger schreibender API-Routen.
- Bisher keine VPS-Aktivierung von P1-06 nachgewiesen. Ein erfolgreicher Cloudflare-Access-Login ist **nicht** identisch mit einem erfolgreichen Test der Anwendungs-Admin-Authentifizierung.
- Keine externen/offsite Backups beschlossen. PostgreSQL-Aktivierung ist ein gesonderter Vorgang und nicht Teil dieser Dokumentationsänderung.

## Freigabebedingungen

PR mit Review und grünen CI-Checks, dokumentierter Betriebsentscheidung für Secret-Provisionierung, explizite Deploy-Freigabe, erfolgreicher anonymer/authentifizierter HTTP-Test sowie klarer Rollback-Nachweis. Bis dahin ist die Admin-Authentifizierung opt-in und deaktiviert.
