# P1-04 – Geplante private Image-Distribution (keine Veröffentlichung)

**Status: Entwurf ohne Betreiberfreigabe für Upload oder VPS-Pull.** Dieses Dokument bereitet einen künftigen, **manuell ausgelösten** Transport über GitHub Container Registry (GHCR) vor.

## Entscheidung

- Docker-Images werden auf einem **GitHub-gehosteten Runner** erstellt und geprüft, nicht auf dem belasteten IONOS-VPS.
- Als Ziel ist die **private GitHub Container Registry** unter dem bestehenden Besitzer `whiteyOnTheMoon` vorgesehen. Es werden nur die zwei Vorschau-Images `web` und `api` übertragen; kein Worker und keine Datenbank-Images.
- Das bestehende Repository bleibt **privat**. Der Veröffentlichungslauf darf nur nach **neuer expliziter Zustimmung** des Betreibers ausgelöst werden und nur vom Branch `main`. Für diese Phase erfolgt keine Veröffentlichung.
- GHCR-Container-Image-Speicherung und Bandbreite sind laut GitHub-Dokumentation derzeit kostenlos; **GitHub-Actions-Minuten für private Repositories sind hingegen kontingentiert bzw. können berechnet werden**. Vor einem manuellen Lauf Budget/Actions-Kontingent und die aktuelle GHCR-Preislage kontrollieren. Kein Tarif-Upgrade, keine Ausgaben ohne Freigabe.
- Für Reproduzierbarkeit eindeutige Tags `sha-<vollständiger-git-commit>` und nach dem Veröffentlichen **Image-Digests** (`@sha256:...`) festhalten. Das ist keine Aussage über permanente Tag-Unveränderlichkeit. **Nie** `latest` zur Freigabe verwenden.

### Vorgesehene Pakete

- `ghcr.io/whiteyonthemoon/videonews-studio-web`
- `ghcr.io/whiteyonthemoon/videonews-studio-api`

GitHub veröffentlicht GHCR-Pakete normalerweise privat und verknüpft sie bei der Erstellung per `GITHUB_TOKEN` mit dem Workflow-Repository. **Nach dem ersten Push die effektive Paket-Sichtbarkeit ausdrücklich kontrollieren**. Keinen Schritt zur Änderung der Sichtbarkeit nach Public vorsehen.

## Stufen und Zuständigkeiten

1. **Derzeit:** Nur Workflowcode `.github/workflows/p1-04-publish-ghcr.yml` vorbereiten. Er hat ausschließlich den Trigger `workflow_dispatch`, besitzt ein explizites Eingabefeld `approval` und lässt Veröffentlichungen nur mit `PUBLISH_PRIVATE_IMAGES` vom `main`-Branch zu. Ein Commit oder Pull Request allein publiziert nichts.
2. **Später, nach Merge und eigenständiger Betreiberfreigabe:** Vor dem manuellen Workflowstart überprüfen, dass die aktuelle CI (inkl. Compose-Preview) grün ist, das Actions-Budget reicht und die Pakete privat bleiben. Der Publishing-Workflow erstellt die beiden Images erneut, prüft die internen HTTP-Endpunkte und lädt die Images erst **danach** in GHCR.
3. **Noch später und erneut freizugeben:** Auf dem VPS aus einem geprüften Repository-Checkout nur die exakt freigegebenen Images nach Digest ziehen. Für private GHCR-Images benötigt der VPS einen geeigneten lesenden GitHub-Zugang (`read:packages`; keine Tokens in Git, Screenshots, Terminalprotokolle oder Chat kopieren). Ein Container-Download verbraucht weiterhin VPS-Datenträgerplatz und Bandbreite.
4. **Interner Preview ohne Build:** Der opt-in Compose-Override `deploy/compose.images.yaml` ersetzt die beiden `image`-Werte durch zuvor festgelegte Digest-Referenzen und entfernt die lokalen `build`-Blöcke mit `!reset null`. Er veröffentlicht **keine** Host-Ports. Mit `pull_policy: never` darf beim späteren Preview-Start nichts unerwartet nachgeladen werden; ein ausdrücklich genehmigtes `docker pull` erfolgt vorher separat.
5. **Vor jeder Aktivierung:** Das rein lesende VPS-Preflight ausführen, Größe der zu transferierenden Images gegenüber dem freien Speicher prüfen, diskretes Monitoring und projektbezogenen Rollbackplan bestätigen. Bestehende Cloudflare-Tunnel, andere Container und Volumes nicht anrühren.

## Test des Compose-Overrides ohne Images oder Zugangsdaten

Für einen reinen Konfigurationstest kann ein CI-Runner **syntaktische Dummy-Digests** einsetzen und den zusammengeführten Compose-Plan mit `docker compose config` untersuchen. Das belegt **nicht**, dass diese Images existieren, herunterladbar oder für den VPS freigegeben wären.

## Noch nicht erlaubt

- Den manuellen GHCR-Veröffentlichungsworkflow auslösen
- Token für private Packages erstellen, teilen oder auf dem VPS speichern
- Private Images herunterladen, neue Container starten, vorhandene Dienste bearbeiten
- Caddy/Cloudflare/HTTPS veröffentlichen, bevor P1-06-Authentifizierung und Ingress-Prüfung abgeschlossen sind

Die Ausnahme vom unabhängigen Review für die alten PRs #70–#72 gilt **nicht** für PR #73.


## Größenmessung vor jeder Übertragung

**Messung nur auf GitHub Actions:** Der Workflow `.github/workflows/p1-04-build.yml` protokolliert für die lokal erstellten Docker-Images Web, API und Worker die mit `docker image inspect .Size` ermittelten entpackten Größen. Für **Web und API gemeinsam** werden zusätzlich (1) die unkomprimierte Bytezahl eines gemeinsamen `docker save`-Exports und (2) die Bytezahl eines beispielhaften `gzip -1`-Streams berichtet. Die Ergebnisse stehen ausschließlich im GitHub-Actions-Jobprotokoll und seiner Job-Zusammenfassung. **Es wird dabei kein Image in GHCR veröffentlicht und kein Artefakt zum VPS übertragen.**

Diese Werte sind **nicht** identisch mit den tatsächlichen GHCR-Downloadbytes, deduplizierten Docker-Layergrößen, persistenter VPS-Plattenbelegung oder temporär benötigtem Speicher beim Pull. Insbesondere darf man die beiden Einzelwerte der Images nicht unbesehen addieren, weil Schichten gemeinsam genutzt werden können.

**Sicherheitsgrenze vor einem späteren Transfer:**

1. Erst tatsächliche Größen messen und im Issue P1-04 mit Git-Commit und CI-Run dokumentieren, keine Werte erfinden.
2. Dann verfügbare Kapazität auf dem VPS **erneut rein lesend** ermitteln und zusätzlich Spielraum für Layer-Download, Entpacken, vorhandene Images und Anwendungen berücksichtigen. Ein grüner Vorabcheck ist noch keine Startfreigabe.
3. GHCR-Upload, Token-Erstellung, Image-Pull und Containerstart bleiben **jeweils gesondert zu genehmigende** Schritte. Keine unautorisierten Kosten und kein Löschen anderer Docker-Images/Build-Caches.
