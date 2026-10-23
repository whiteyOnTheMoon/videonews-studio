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

### Gemessener Referenzlauf (GitHub Actions, 23.10.2026)

Quelle: [P1-04 Docker image smoke tests, Run #39913543830](https://github.com/whiteyOnTheMoon/videonews-studio/actions/runs/39913543830), Image-Messung auf Commit `f45b153fc388ee4e6dc326cd5e1ff815e46f62b7`, ohne Push/Download zum VPS.

| Messgröße                                           |     Bytes |   Rundung |
| --------------------------------------------------- | --------: | --------: |
| Web-Image, `docker image inspect .Size`             | 703968042 | 671,4 MiB |
| API-Image, `docker image inspect .Size`             | 703968042 | 671,4 MiB |
| Worker-Image (nicht für Preview vorgesehen)         | 703968042 | 671,4 MiB |
| Gemeinsamer Web+API-`docker save`-Tarstream         | 718111744 | 684,8 MiB |
| Gemeinsamer Web+API-`docker save`-Stream, `gzip -1` | 263412493 | 251,2 MiB |

Alle Images sind in diesem Scaffold gleich groß, da der Laufzeitteil des Dockerfiles den gesamten gebauten Workspace enthält. Der gemeinsame Export zeigt den Effekt geteilter Schichten. Diese Messung kann sich bei Code-/Abhängigkeitsänderungen ändern und ist **kein Nachweis der tatsächlichen Registry-Downloadgröße, Netzwerkübertragung oder des VPS-Speicherbedarfs**.

**Nächste Sicherheitsentscheidung:** Keine lokalen VPS-Builds, kein GHCR-Push, kein Image-Pull und kein Start allein aufgrund der Zahlen. Vor einem späteren Pull den freien Platz neu messen und Reserve für temporären Download sowie entpackte Layer einplanen. Der bisherige Host-Snapshot wies 24 GB freie Platte und 1,4/2,0 GiB Swap-Belegung aus.

## GHCR-Veröffentlichungsfreigabe – zusätzliche Sicherheitsschranken

**Stand: 23.10.2026; vorbereitet, kein Upload genehmigt oder ausgeführt.** Die GitHub-Dokumentation bestätigt, dass neue GHCR-Pakete unter einem persönlichen Konto standardmäßig **privat** sind. Das gilt **nicht automatisch für schon bestehende Pakete**. Ein privates Quell-Repository allein beweist nicht die Paketsichtbarkeit.

Der geplante manuelle Workflow erfordert daher neben der ausdrücklichen Auswahl `PUBLISH_PRIVATE_IMAGES`:

1. **Verifizierter Quellstand:** Der Betreiber gibt den **exakten 40-stelligen Git-Commit-SHA von `main`** separat frei und trägt ihn in `expected_sha` ein. Jede Abweichung von `GITHUB_SHA` führt vor dem Build zum Abbruch.
2. **Paketstatus vor dem Lauf manuell kontrollieren:** Im GitHub-Profil `whiteyOnTheMoon` unter **Packages** prüfen, ob `videonews-studio-web` und `videonews-studio-api` bereits existieren. Falls vorhanden, muss **jedes** Paket sichtbar als **Private** gekennzeichnet sein; bei bereits öffentlich sichtbaren Paketnamen niemals diesen Workflow nutzen. Das Auswahlfeld `visibility_check = NO_PUBLIC_PACKAGE` darf nur nach dieser Prüfung gesetzt werden.
3. **Zweite automatische Sichtbarkeitsschranke (authentifiziert):** Vor dem Build fragt der Workflow mit dem kurzlebigen GitHub-Actions-Token für beide Namen die GitHub-Packages-Metadaten ab, statt ohne Anmeldung. Ein öffentlich gefundenes Paket (HTTP 200) oder eine fehlerhafte/unklare Antwort (z. B. 401/403) blockiert. HTTP 404 beweist **nicht**, dass kein privates Paket existiert. Die manuelle Prüfung bleibt zwingend. Dieser reine Lese-Check wird zusätzlich in der PR-CI getestet.
4. **Kostenfreigabe:** Vor dem Lauf die GitHub-Billing-Ansicht auf verbleibende GitHub-Actions-Minuten, Usage und Budgetgrenze prüfen. GHCR-Container-Image-Speicherung und -Bandbreite sind laut GitHub derzeit kostenfrei, **private Actions-Minuten jedoch nicht unbegrenzt**. Kein kostenpflichtiges Upgrade, kein Überschreiten des bewilligten Limits.
5. **Veröffentlichen nur nach neuer ausdrücklicher Zustimmung:** `workflow_dispatch` im `main`-Branch starten; Standardwahl ist `DO_NOT_PUBLISH`, der Job läuft nur bei `PUBLISH_PRIVATE_IMAGES`. Läufe werden seriell ausgeführt. Der ausgehende Push verwendet nur den kurzlebigen `GITHUB_TOKEN` mit `packages: write` und versieht die beiden Images mit commitgebundenen Tags und Digest-Nachweis.
6. **Nach dem Lauf erneut prüfen:** Unter **Packages** bei beiden neuen Images explizit `Private` bestätigen, Repository-Zuordnung und Actions-Berechtigungen kontrollieren und erst anschließend die exakten Digests aus der Workflow-Zusammenfassung festhalten. Bei Teilerfolg (z. B. Web gepusht, API fehlgeschlagen) **keine** automatische Fortsetzung auf dem VPS; erst Zustand prüfen.

Die öffentlichen GitHub-Package-API-Abfragen ersetzen keine manuelle Prüfung im eingeloggten GitHub-Konto; sie können private Pakete nicht offenlegen. Die GHCR-Veröffentlichung selbst ist **nicht** Teil der CI-Tests für diesen Draft-PR und wurde nicht simuliert.

**Der VPS bleibt separat:** Kein Registry-Login, Token, Image-Download, Compose-Start, Portfreigabe oder Eingriff in vorhandene Cloudflare-Netze durch diesen Ablauf. Jede dieser Aktionen benötigt eine neue ausdrückliche Betreiberfreigabe. Eine Review-Ausnahme für eine ältere PR gilt nicht automatisch für diese Änderung.

### Erster Veröffentlichungsversuch gescheitert (23.10.2026)

Im [Workflow #39981302874](https://github.com/whiteyOnTheMoon/videonews-studio/actions/runs/39981302874) lieferte die **nicht authentifizierte** GitHub-Package-Abfrage **HTTP 401**. Der Sicherheits-Check stoppte vor Docker-Build, GHCR-Anmeldung und Docker-Push: **Kein Image wurde veröffentlicht**. SHA und Sichtbarkeitsbestätigung waren korrekt. Die Korrektur verwendet nur das kurzlebige `GITHUB_TOKEN`. Bei 401/403 bleibt weiterhin alles blockiert. Erst nach grüner PR-CI und separater Merge-Freigabe einen **neuen** manuellen Lauf mit neu geprüftem `main`-SHA starten; den alten fehlgeschlagenen Lauf nicht erneut ausführen.
