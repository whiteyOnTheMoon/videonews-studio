# P1-06 – explizites Admin-Compose-Overlay

**Nur vorbereitet – nicht auf dem VPS aktiviert.** Die öffentliche Vorschau liegt hinter Cloudflare Access unter `https://studio.ap-pixels.com`; die zusätzliche Anwendungsauthentifizierung ist unabhängig davon.

## Mechanismus

Die Datei `deploy/compose.admin.yaml` wird nur wirksam, wenn der Betreiber sie ausdrücklich zusätzlich zur Basis-Compose-Datei angibt. Normale Starts mit `compose.yaml` bleiben unverändert.

- `web` aktiviert den serverseitigen Adminbereich und die interne API-Weiterleitung `http://api:4000`.
- `api` aktiviert die Passwortprüfung und erhält den Hash ausschließlich aus `/run/secrets/admin_password_hash`.
- Der Host-Dateipfad ist `./secrets/admin_password_hash`; das gesamte lokale `secrets/`-Verzeichnis ist in Git ignoriert.
- Das Overlay veröffentlicht **keine Host-Ports**, startet weder Postgres noch Redis und ändert keine Cloudflare-Tunnel.
- **Nicht** `VNS_ADMIN_PASSWORD_HASH` parallel setzen: konkurrierende Hashquellen führen absichtlich zum Startfehler.

## Voraussetzungen einer späteren Freigabe

1. PR reviewen, CI-Grün bestätigen und exakte freizugebende Web-/API-Image-Digests bestimmen.
2. Unter Verantwortung des Betreibers ein starkes Admin-Passwort offline erzeugen und ausschließlich den passenden scrypt-Hash in der lokalen Datei `secrets/admin_password_hash` ablegen. **Keinesfalls Passwort oder Hash in Chat, Repository, Log-Ausgabe oder CI speichern.**
3. Datei auf dem Host für andere Hostnutzer unzugänglich halten und vor dem ersten Start prüfen, ob sie im nichtprivilegierten API-Container unter `/run/secrets/admin_password_hash` lesbar ist. Docker Compose kann bind-montierte Secrets containerintern lesbar bereitstellen; der Hostschutz bleibt davon getrennt.
4. `VNS_ADMIN_ORIGIN` muss exakt die freigegebene HTTPS-Origin sein, aktuell `https://studio.ap-pixels.com`.
5. Compose-Dateien bei einer **gesonderten Betreiberfreigabe** in kontrollierter Reihenfolge kombinieren: Basis, gegebenenfalls digest-pinned Image-Override und zuletzt Admin-Overlay. Keine automatische Aktivierung und keine Veröffentlichung über GitHub Actions.
6. Danach Cloudflare Access und zusätzlich den Anwendungs-Login testen: unautorisierter Adminzugriff, korrekte Cookies, CSRF, Ratenbegrenzung, Logout und Neustartverhalten.
7. Rollback: vorherige Image-Digests und Compose-Dateiauswahl wiederherstellen; keine fremden Container oder Netzwerke verändern.

**Hinweis:** Der Secret-Pfad in der Compose-Datei ist relativ zum Verzeichnis der _ersten_ Compose-Datei. Mit der Projektdatei `compose.yaml` im Repository-Stamm zeigt er deshalb auf `./secrets/admin_password_hash`. Der Passwort-Hash ist ein Zugangsschlüssel und sollte trotz Hashing geheim gehalten werden.

Diese Integration prüft nur die Konfiguration. Sie ist keine Freigabe, auf dem VPS Secrets zu erzeugen oder Admin-Zugang öffentlich zu aktivieren.
