# P4-11 – Begrenzter VPS-Image-Build als Releasekandidat

**Betreiber-Freigabe 2026-11-09:** Einleitung der technischen Bereitstellung. PR #481 wurde von Draft auf Ready for Review gesetzt; die gesonderte unabhängige Codeprüfung bleibt offen. Dieses Skript baut ausschließlich **lokale Kandidatenimages** und tauscht keinen laufenden Dienst aus.

## Ausgangslage

- Private Ozonloch-MP4 wurde auf VPS durch `ap` erfolgreich erzeugt: 570.958 s, 13,625,568 Bytes, SHA-256 `52e9990d3c77d0bad5dd42df6bdd265e871add6fa8d3a961295ca06f49b96eed`.
- Isolierter Docker-Canary aus dem bestehenden API-Image (ohne Netzwerk oder Secrets, UID 1000, read-only Bind) hat Größe und SHA-256 der Datei geprüft: `VIDEO-ZUGRIFF BESTANDEN`.
- Geschützter Host-Ordner `/home/ap/videonews-previews` bleibt UID 1000/0700; MP4 bleibt 0600. Kein öffentliches Static-Serving.
- Laufendes Compose-Projekt `videonews-studio`, Web und API sind UID 1000 und schreibgeschützt. Die bestehenden API- und Web-Image-IDs wurden vom Betreiber dokumentiert; keine anderen Anwendungen antasten.
- Letzter Host-Check: 3615 MiB MemAvailable, 477 MiB SwapFree, ~18 GB Datenträger frei. Das sind **Momentwerte**; Builder prüft unmittelbar vor jedem Build mindestens 3500 MiB verfügbaren RAM, 256 MiB freien Swap und 16 GiB freien Docker-Speicher.

## Stufe A: Releasekandidat erzeugen – keine laufende Anwendung ändern

Das bei der Renderabnahme angelegte separate Worktree `/home/ap/videonews-pilot-481` ist vorgesehen. Der Owner führt den folgenden Block nach Sichtprüfung aus. Er darf auch vor dem späteren Merge ausgeführt werden, weil die gebauten Bilder ausschließlich **lokale, unbenutzte Kandidaten** sind. Der PR-Head muss exakt bekannt und mit dem abgefragten Pull-Request-Ref identisch sein. Vor jedem Aufruf das exakte 40-stellige `SHA` aus der endgültigen GitHub-Prüfung einsetzen.

```bash
(
  set -euo pipefail
  umask 077

  SHA="EXACT_REVIEWED_PR_HEAD_SHA"
  TEST="/home/ap/videonews-pilot-481"

  test "$(id -un)" = "ap"
  test -d "$TEST"
  test "$(git -C "$TEST" branch --show-current)" = ""
  test -z "$(git -C "$TEST" status --porcelain)"

  cd /home/ap/www/videonews-studio
  git fetch --no-tags origin refs/pull/481/head
  test "$(git rev-parse FETCH_HEAD)" = "$SHA"

  git -C "$TEST" checkout --detach "$SHA"
  bash "$TEST/scripts/p4_11_bounded_candidate_build.sh" --expected-sha "$SHA"
)
```

Das geprüfte Builder-Skript bleibt innerhalb eines eigens erzeugten BuildKit-Containers mit 2048 MiB RAM **einschließlich** Swap, maximal einem parallelen Task, und baut `api` und `web` einzeln. Es kontrolliert die laufenden Videonews-Container-IDs und Zeitstempel vor und nach dem Build sowie den unveränderten Haupt-Checkout. Der Builder wird nach erfolgreichem Build oder Fehler bereinigt; neu entstandene Kandidaten-Images bleiben für eine spätere sichere Bereitstellung gespeichert. Kein `docker compose up`, `docker push`, Netzwerk-Port, Credentials-Export oder Video-Encoding auf GitHub.

**Abbruch:** Wenn die Ressourcengrenzen nicht erfüllt sind, eine Image-Tag-Kollision besteht, ein anderes Container-Image unerwartet verändert wird oder die Worktree-Checks fehlschlagen, **nicht erzwingen, nicht neu starten, nicht auflockern**. Alte Images sind weiter aktiv.

## Stufe B: Review und separates Deployment-Runbook

Für die eigentliche Site-Aktivierung sind gesondert erforderlich:

1. Unabhängigen Code-Review dokumentieren oder ausdrücklich gesonderte Betreiber-Ausnahme nach Governance-Richtlinie beschließen; PR #481 reviewen und vor Merge exakte CI-Gates prüfen. Die bloße Freigabe im Chat gilt **nicht als unabhängiger Code-Review**.
2. Release-Images anhand OCI-Revision und vollständigen Image-IDs verifizieren, bisherige Web/API-Image-IDs und Digest-Refs für Rollback festhalten; alle vorhandenen Compose-Overlay-Dateien, Secrets, persistenten Volumes, Netzwerke und private HTTPS-Admin-Gates beibehalten.
3. `deploy/compose.private-previews.yaml` **zusätzlich** in den bestehenden Compose-Stapel aufnehmen, nur die beiden Listing-Flags nach Betreiberentscheidung aktivieren. Die beiden `*_RENDER_ENABLED` bleiben `false`. Die read-only Bind-Dateisystemeigenschaften sind im Canary nachgewiesen; Web-Container erhält keinen Mount.
4. Nur API und Web mit `--no-deps --no-build --pull never` zielgerichtet ersetzen, Health-Checks und private Login-Tests ausführen; auf Fehler exakt scoped Rollback, niemals globale `docker compose down/up` oder Neustart anderer Dienste.
5. Echten Besitzer-Login in `https://studio.ap-pixels.com/admin` und in der persönlichen Editor-Sitzung nachweisen. Tab Videos: Liste, Browser-Playback mit Range-Responses und authentifizierter MP4-Download; anonyme und Editor-ohne-Admin-Zugriffe verweigern. Ein Cloudflare-Tunnel allein ist **kein** Zugangsschutz.

**Noch nicht erfüllt:** Merge, neue Docker-Images auf VPS, Site-Update, echter Live-Player-Test und Produktions-TTS. Live-News-Recherche und Renderbutton bleiben für separate Freigaben deaktiviert.
