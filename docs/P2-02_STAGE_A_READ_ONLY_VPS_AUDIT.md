# P2-02 Stage A – lesende VPS-Bestandsaufnahme

**Zweck:** Nichtdestruktiver Nachweis des derzeitigen Hosts vor jeder produktiven Aktivierung. **Kein Deployment und keine Produktionsfreigabe.** Zuletzt vorgesehener Commit bei Erstellung dieser Anleitung: `9d94f348ca491adffacd958fa14520cff8487f7b`. Vor einem späteren Rollout den SHA erneut über GitHub verifizieren.

## Grundregeln

- Keine `git pull`-, `git fetch`-, `docker compose up/down`-, Restart-, DB-, Redis-, Migration-, Backup- oder Beszel-Schreibbefehle.
- Keine `docker inspect`, `docker logs`, `docker compose config`, `printenv`, `env` oder `cat` auf produktive Secrets. Keinen privaten API-Key, Dateipfad zu einem Secret oder Zustell-Link in Chat/GitHub kopieren.
- Das Python-Skript `scripts/p2_02_stage_a_vps_inventory.py` nutzt ausschließlich drei begrenzte Lesebefehle (Git SHA, Git Status nur für versionierte Dateien, Docker-Containerübersicht anhand des festgelegten Compose-Projektlabels) und `statvfs("/")`. Es gibt nur aggregierte, erlaubte Statusfelder aus.
- Die Docker-Abfrage ist auf `com.docker.compose.project=videonews-studio` beschränkt. Ein anders benanntes Compose-Projekt ist nur über `--project-name` ausdrücklich auswählbar. Nicht gefundene Dienste sind **nicht beobachtet**, nicht als fehlfrei zertifiziert.
- `stage_a_readiness=reviewable` heißt ausschließlich: Die wenigen lesbaren Basisdaten sind unauffällig und für **weitere** Freigabeprüfung geeignet. `production_authorized` bleibt unabhängig davon immer `false`.

## Unmittelbar auf dem vorhandenen VPS ausführbar (ohne Repo-Update)

Der folgende Block verwendet ausschließlich bereits verfügbare Git-/Docker-Kommandos und schreibt weder Dateien noch Konfigurationswerte. Er gibt **keine** Git-Status-Pfade oder Docker-Umgebungsvariablen aus.

```bash
(
  set -uo pipefail
  cd /home/ap/www/videonews-studio || exit 2
  echo '=== P2-02 Stage A: lokaler Git-Commit ==='
  GIT_OPTIONAL_LOCKS=0 git rev-parse --verify HEAD
  echo '=== Versionierte Dateien unverändert? ==='
  if [ -z "$(GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=no)" ]; then
    echo 'tracked_worktree_clean=true'
  else
    echo 'tracked_worktree_clean=false'
  fi
  echo '=== Nur VideoNews Compose-Container ==='
  docker ps --all --filter 'label=com.docker.compose.project=videonews-studio' \
    --format '{{.Label "com.docker.compose.service"}} | {{.State}} | {{.Status}}'
  echo '=== Root-Datenträger ==='
  df -h /
)
```

Die Ausgabe enthält nur Commit, Status, Compose-Servicebezeichnungen und aggregierte Speichernutzung. Bei fehlender Docker-Berechtigung **nicht** blind `sudo` oder ACL-Rechte verändern; als Blocker dokumentieren.

## Repository-Version (nur falls die Datei bereits auf dem Host vorhanden ist)

```bash
python3 scripts/p2_02_stage_a_vps_inventory.py \
  --repo /home/ap/www/videonews-studio \
  --expected-sha 9d94f348ca491adffacd958fa14520cff8487f7b
```

Das Skript ändert nichts. Ausgabe JSON mit `stage_a_readiness` (`reviewable` oder `blocked`). Rückgabewert 0/2 ist **keine** Freigabe des Produktivbetriebs. Nicht eigens `git pull` ausführen, nur um die Datei auf dem VPS zu erhalten; dafür wäre eine separate Änderung des lokalen Repositorys erforderlich.

## Nach dem echten Stage-A-Bericht

1. Vergleich des VPS-Commits und aller beobachteten Container mit dem beabsichtigten Release; prüfen, ob mehrere konkurrierende Feed-Producer laufen und ob Feed-Container Host-Ports veröffentlicht haben. Bei abweichendem SHA nicht einfach den produktiven Code aktualisieren.
2. **Außerhalb dieses automatischen Berichts:** unabhängige Freigabe von 3–5 Quellen samt Lizenzen und erlaubten Intervallen; Signatur-/Anker-Vertrauen und persönliche DB-Identitäten. Bestehender `p2_feed_host_preflight.py` kontrolliert ausschließlich _Metadaten_ mit separat bereitgestellter Konfiguration und dokumentierter Lesefreigabe.
3. Offsite-Backup und tatsächlich restaurierte PostgreSQL-/Redis-/Quellen-Daten unabhängig prüfen; Beleg und RPO/RTO dokumentieren.
4. Beszel-Betrieb und Notification-Empfang über den vorhandenen Hub durch den Betreiber persönlich prüfen. Ein sichtbares `healthy` ist **keine** nachgewiesene Alarmzustellung.
5. Erst nach expliziter, neuer Freigabe für **konkreten SHA, Host, Image-Digests und Quellen** eine inaktive Canary-Stufe und anschließend kontrollierte Einmalbeobachtung durchführen. Rollback muss vorher nachgewiesen sein.

Bei einer späteren Freigabe darf `#17` erst geschlossen werden, wenn die realen Abnahmen nachgewiesen sind. Für die gesamte Phase 2 gelten zusätzlich die vorhandenen Regeln in `docs/P2_ROLLOUT_READINESS_2026-10-26.md`.
