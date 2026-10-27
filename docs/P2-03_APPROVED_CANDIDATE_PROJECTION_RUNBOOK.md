# P2-03 — Geprüfte Feed-Kandidaten in persistierte Ereignisse übernehmen

**Status: code-ready for independent staging; NOT deployed or production-accepted.**
Dieser Integrationsschritt hebt den bisherigen nur dem nicht einloggbaren `vns_feed_project_executor` zugänglichen P2-03-Offline-Port auf eine technisch ausführbare, aber weiterhin standardmäßig deaktivierte Komponente. Er bleibt **ohne Publisher-, Claim-, Skript- oder Veröffentlichen-Rechte**.

## Datenfluss

1. Der unabhängig genehmigte P2-01/P2-02-Feed-Poller erzeugt nur `review_status=candidate`-Metadaten in `vns.feed_poll_candidates`.
2. Eine **getrennt verwahrte** PostgreSQL-LOGIN-Rolle `vns_feed_project_login_...` besitzt ausschließlich Mitgliedschaft im `vns_feed_project_client`. Die Migration 0035 erzeugt **keine** Login-Zugangsdaten. Sie lässt die separate Besitzerrolle `vns_feed_project_executor` weiterhin nicht einloggen.
3. `vns.project_approved_feed_candidates()` überprüft in **derselben DB-Transaktion** die aktuelle Quellenregister-Revision sowie die unabhängig erteilte Hostfreigabe und deren unveränderte Revisionsbindung. Bei Revocation, später hinzugefügtem spezielleren Scope oder einer fremden Kandidaten-URL stoppt die gesamte Projektion.
4. Nur danach wird die schon vorhandene idempotente Projektion ausgeführt. Sie legt `research_articles`, `research_events` und `research_event_articles` an, aber **keine** `research_claims`, Urteile, Storybooks oder Upload-Events.
5. `feed-candidate-project-once.ts` validiert den tatsächlichen PostgreSQL-`session_user` gegen den erwarteten benannten Login sowie die feinsten Privilegien. Der Dienst liest genau ein lokales, 0400/0600-geschütztes Passwort und nutzt einen beschränkten Datenbankpool. Er erstellt keinen Scheduler, keinen Queue-Worker, keine Netzwerkabfragen an Nachrichtenquellen und keine veröffentlichbaren Skripte.

## Deploymentvertrag

Der neue Overlay `deploy/compose.feed-projection.yaml` wird **nicht automatisch** in `compose.yaml` eingebunden. Das einzige Profil `feed-project` ist explizit opt-in, besitzt kein Hostport-Binding, ist read-only, besitzt einen separaten UID/GID 10004, eine begrenzte tmpfs-Fläche, `restart: no`, einen eigenen DB-Secret-Bind-Mount und allein das interne Docker-Netz `backend`.

Einstellungen sind **nicht im Code als reale Nachrichtenquellen hardcodiert**:

| Variable                                  | Voraussetzung                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `VNS_P2_FEED_PROJECTION_ENABLED`          | `true`, nach separater Freigabe                                         |
| `VNS_P2_FEED_PROJECTION_OPERATOR_ACK`     | `true`, nach separater Freigabe                                         |
| `VNS_P2_FEED_PROJECTION_MODE`             | `single_pass`                                                           |
| `VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP` | `false`                                                                 |
| `VNS_P2_FEED_PROJECTION_DB_HOST`          | Nur `postgres` im Compose-Netz bzw. `127.0.0.1` in CI                   |
| `VNS_P2_FEED_PROJECTION_DB_USER`          | Separates, eingeschränktes benanntes LOGIN `vns_feed_project_login_...` |
| `VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE` | Genau `/run/secrets/vns_feed_project_db_password`                       |
| `VNS_P2_PROJECTOR_DB_PASSWORD_FILE`       | Vom Betreiber vorprovisionierte Host-Datei, bind mount, nie GitHub      |
| `VNS_P2_FEED_PROJECTION_SOURCE_ID`        | Existierende, **aktuell im Admin-Register freigegebene** Source-ID      |
| `VNS_P2_FEED_PROJECTION_LIMIT`            | 1–100 pro ausdrücklich freigegebenem Lauf                               |

Der Admin-Quellenkatalog und seine separate Hostfreigabe sind die Datenbankautorität. Das CLI nimmt nur die konkrete, erlaubte Quelle für den einzelnen Übergang entgegen. Keine Live-Quelle, API-Key oder private Belege werden als GitHub-Default definiert.

## Tests und offene Produktionsbedingungen

Die PostgreSQL-Migration ist in die reversible Zwei-Durchläufe-Migrations-CI aufgenommen; ihre SQL-Negativtests beweisen fehlende direkte Kandidaten-/Claim-Rechte, aktuelle Hostfreigabe, Revocation, idempotenten Event-Handoff und dass der Projektor niemals Claims erfindet. Der Real-Port-Test verbindet sich mit einem **eigenen** Test-LOGIN am wegwerfbaren PostgreSQL und weist ohne Freigabe die Projektion zurück. Ein separater Compose-Vertrag verhindert versehentliche Profile-, Berechtigungs- oder Egress-Erweiterungen.

Die eigentliche Produktionsabnahme bleibt offen: persönlich ausgestellte Login-Secrets, bestätigte reale Quellenrechte, Freigabe konkreter DB-Migrationen nach Backup/Rollback-Abstimmung, kontrollierter VPS-Start, echte Quellen-/Feed-Daten und Admin-basierte Freigabe für alle nächsten redaktionellen Schritte P2-04 bis P2-10. Betreiberbestätigte **IONOS-Backups und Beszel** werden übernommen; keine neue Backup- oder Monitoring-Infrastruktur wird aufgebaut.

**No automatic activation:** Nur separate Freigabe für konkrete Migration/Compose/Source/Release, kein `docker compose up`, kein `git pull`, keine Schlüsselprovisionierung und keine Kosten während dieses PRs.
