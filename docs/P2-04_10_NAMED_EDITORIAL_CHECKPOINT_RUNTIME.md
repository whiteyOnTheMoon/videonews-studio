# P2-04–P2-10 – Revisionsgesicherte redaktionelle Prüfentscheidungen im Admin-Tool

**Status:** Implementiert als **explizit freizugebender** echter API/Web/PostgreSQL-Pfad; auf dem VPS noch nicht aktiviert. Dieser Pfad erzeugt **keine** automatisch geprüften Claims oder produktiven Skripte und erteilt **nie** Veröffentlichungsfreigaben. Er ersetzt das bisherige lediglich lesbare Checkpoint-API durch eine revisionsgebundene Schreibmöglichkeit.

## Datenfluss und persönliche Verantwortlichkeit

1. Das bestehende Editor-Login verwaltet serverseitig sichere `__Host-vns_editor`-Sessions. Der Admin muss sich tatsächlich persönlich als aktiver Admin anmelden.
2. Web/Next.js erlaubt nur denselben Origin, recheckt `/editor/me`, prüft Request-JSON streng, entfernt jeden browserseitig behaupteten Akteur und leitet ausschließlich einen festen Backendpfad weiter.
3. Die API prüft die gültige persönliche Editor-Session erneut. Nur bei beiden expliziten Aktivierungsflags öffnet sie **eine eigene physische PostgreSQL-Session pro Anfrage** mit der dedizierten `editor_<username>`-LOGIN-Identität. Das Passwort kommt ausschließlich aus dem vorab geprüften lokalen Secretverzeichnis, niemals aus dem Request oder GitHub.
4. `vns.named_current_editor()` verknüpft `session_user` mit dem **gleichen** aktuellen Admin-Konto/Authentication-Version wie im persönlichen Cookie. Rollenmitgliedschaft in `vns_p2_named_client` und `vns.editor_db_principals`-Eintrag müssen vorher durch einen unabhängigen DBA autorisiert werden.
5. Ein `POST /admin/editorial-checkpoints` überträgt nur `eventId`, `expectedRevision`, `stage`, `outcome`, `artifactSha256`, `reasonCodes` und optionalen `score`. Der Server prüft exakte Felder und Werte und ruft ausschließlich `vns.named_append_editorial_checkpoint(...)` auf.
6. Die Datenbank fügt im vorhandenen append-only Log `vns.editorial_checkpoint_log` **eine neue** Revision mit echtem `actor_id`, Auth-Version, Zeitstempel, Artefakt-Hash und SHA-256-Verkettung hinzu. Revisionskonflikte → HTTP 409. Skriptautoren dürfen ihre eigene Qualitätsprüfung **nicht** signieren; die SQL-Funktion erzwingt unabhängigen Reviewer. Ohne passende persönliche Rolle wird der Eintrag abgewiesen.
7. Der Admin erhält `{saved:true,revision,approvedForPublication:false}`. Die Oberfläche bietet nie ein Veröffentlichungskommando. Bestehende, persönlich authentifizierte GET-Exportwege für Profile, Checkpoints und redaktionelle Timeline bleiben unverändert.

## Konfiguration ohne Hardcodes und unabsichtliche Aktivierung

Der bereits vorhandene Admin-Quellenkatalog, Profile und Checkpoints verbleiben in PostgreSQL. Kein Provider/API-Key oder Nachrichten-Host ist im Code festgelegt.

| Setting                                     | Explizite Operator-Anforderung                                      |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `VNS_EDITORIAL_PERSONAL_DB_ENABLED`         | `true`                                                              |
| `VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK`    | `true`                                                              |
| `VNS_EDITORIAL_PERSONAL_DB_HOST`            | `postgres` im Backendnetz                                           |
| `VNS_EDITORIAL_PERSONAL_DB_SECRETS_DIR`     | `/run/secrets/vns_editor_credentials`                               |
| `VNS_P2_EDITORIAL_PERSONAL_CREDENTIALS_DIR` | Lokal provisioniertes Secret-Verzeichnis, über read-only Bind-Mount |
| `VNS_WEB_EDITORIAL_ADMIN_ENABLED`           | `true` nur für bewusst freigegebene Admin-Anfragen                  |

Die erste persönliche LOGIN-Rolle z. B. `editor_<username>` und ihre `vns.editor_db_principals`-Zuordnung werden **nicht** durch eine Migration automatisch erzeugt. Eine andere Person oder ein unabhängiger Administrator vergibt nur `vns_p2_named_client`-Rechte; kein Direktzugriff auf Audit-Tabellen, Claims, Admin-Register oder Provider-Keys. Das Login muss exakt zur wirklich authentifizierten `username` passen. Aktivierungsflags allein genügen nicht als DB-Recht.

Die Secret-Datei des DB-Nutzers heißt `editor_<username>.password`; Inhalte sind unabhängige 40–256-Zeichen-Zufallswerte und liegen ausschließlich außerhalb von Git/Chat/CI. Secret-Verzeichnis 0700/0500, Dateien 0400, Eigentümer Root oder laufender API-User, weder Gruppe noch Andere mit Rechten; keine Symlinks/Hardlinks. Diese Anforderungen sind im Runtime-Code geprüft, nicht bloß dokumentiert.

**Compose:** `deploy/compose.personal-editorial-admin.yaml` ist ein separat zu wählender Overlay für die vorhandene API; keine neuen öffentlichen Ports/Netze, kein neuer produktiver Dienst und kein automatischer Neustart. Beide Backend-Flags sind standardmäßig `false`; fehlt der Bind-Source-Pfad, schlägt bereits die Compose-Auswertung fehl. Bestehender Admin-, Worker- und Feed-Dienst bleiben unverändert, solange der Overlay nicht eigens freigegeben ist.

## Nachweise und Grenzen

- Jest/Node-Unit-Tests: vollständige Body-Shape-/Origin-/Session-/DB-Identitätsgrenzen, falsche Aktoren, Revisionen, Digest, Codes, Rollen und deaktivierte Pfade.
- Bestehende echte PostgreSQL-Migrationstests aus 0030 beweisen individuelle Autor/Reviewer-LOGIN-Zuordnung, CAS, Audit-Verkettung, nicht editierbare Timeline und Verbot der Eigen-QA. Die HTTP-Integration benutzt **dieselbe** Datenbankfunktion.
- Bestehende Admin-API-/Web-Funktionen bleiben „default off“, der reale `apps/api/src/index.ts` kann sie nur bei bewusst gesetztem Operator-Gate und tatsächlich aktivem EditorAuth-Dienst montieren.
- **Weiterhin offen:** Claims aus unabhängigen realen Quellen prüfen; echte Storyboard-/Skriptgenerierung über freigegebene Anbieter; QA durch separaten Agenten plus reale Reviewer; individuelle Nischen- und Risikoregeln; vollständiger P2-10-Export aller Entscheidungen, abgelehnten Claims, Quellen-Lizenzsnapshots und Änderungen. Der hier erzeugte Checkpoint allein beweist keine Faktenrichtigkeit und bedeutet **keine** veröffentlichbare Redaktion.

IONOS-Backups und Beszel werden wie vom Betreiber bestätigt als vorhanden angenommen; keine erneute Infrastrukturwahl und keine Duplikatdienste. Der eigentliche VPS-Rollout benötigt nach wie vor eine separate Freigabe des konkreten Code-/Compose-/Secret-Änderungssatzes.
