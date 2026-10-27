# P2-10 – Persistente Story-Entscheidungskette und Exportpfad

**Status: technisch verbunden, standardmäßig deaktiviert; noch nicht produktiv abgenommen.**

Der neue Story-Timeline-POST verbindet das vorhandene `vns.named_timeline_append(...)` aus Migration 0029 mit dem bereits persönlich gesicherten Admin-Gateway und dem bisher nur lesenden Timeline-Export. Eine neue SQL-Tabelle, ein Publisher-Key oder unkontrollierte Worker-Rechte sind nicht erforderlich.

## Datengrenzen

- `POST /api/admin/editorial-timeline` verlangt eine aktive persönliche Admin-Session, validen exakt passenden HTTPS-Origin, unveränderte Editor-/Auth-Version und **das individuelle PostgreSQL-LOGIN** der Person. Die API vergleicht `vns.named_current_editor()` mit der authentifizierten Session. Die Datenbankfunktion `vns.named_timeline_append` nimmt **keine vom Browser behauptete actor_id** an.
- Request-Schema: `storyId` (UUID einer bereits existierenden Story), `eventKind` aus `source`, `claim`, `claim_rejected`, `review`, `script_revision`, `decision`; `referenceUri` optionaler kanonischer öffentlicher HTTPS-Link; `documentSha256` optionaler SHA-256; `details` mit genau `summary` (8–2000 Zeichen) und `reasonCodes` (1–20 maschinenlesbare Codes). Keine Passwörter, API-Schlüssel, Zugangstokens, Rohartikeltexte oder willkürlichen externen URLs in den Transport einfügen.
- SQL speichert einen eigenständigen, unveränderlichen Datensatz in `vns.editorial_timeline` und bindet die aktive DB-Person samt Zeitstempel an die Story. Revisionen sind append-only. Der Endpunkt gibt nur `{eventId,approvedForPublication:false}` aus, keine automatischen Freigaben.
- `GET /api/admin/editorial-timeline` war bereits über persönlich autorisierte, cursorbasierte `vns.named_timeline_page`-Abfragen verfügbar. Neu angehängte Ereignisse können damit stückweise als vollständige, geordnete Timeline **im Rahmen der dort erfassten Ereignisse** exportiert werden. Es wird nicht behauptet, dass damit schon alle historischen Quellen-/Claim-/Skriptartefakte einer ganzen Produktion erfasst sind.
- Das Admin-Tool zeigt die manuelle Story-Protokollerfassung nur bei `VNS_WEB_EDITORIAL_ADMIN_ENABLED=true`. Die produktive Backend-Funktion benötigt zusätzlich die in `docs/P2-04_10_NAMED_EDITORIAL_CHECKPOINT_RUNTIME.md` dokumentierte personenbezogene PostgreSQL-Aktivierung. Kein neues Datenbankpasswort, Quellhost oder KI-Anbieter wird hardcodiert.

## Sicherheitsgrenzen und restliche Abnahme

Bestehende SQL-Tests für 0024/0029/0031 sichern persönliche Identität, fehlende Runtime-Direktschreibrechte und unveränderliche Timeline. Neue API-/BFF-/UI-Tests prüfen Rechte, CSRF/Origin, ungültige Referenzen, zu große/Fake-Daten, verbotene Rollen und den niemals veröffentlichenden Rückgabewert. CI muss grün sein, bevor dieser Pfad gemergt wird.

Für die echte P2-10-Abnahme fehlen noch: vollständig und automatisch aus allen produktiven Jobs erzeugte Provenienz- und Lizenzsnapshots, claimweise unabänderbare Evidenzverbindungen, echte Skriptgenerator-/QA-Artefaktversionen, beweisbare Cursor-Vollständigkeit über mehrere Seiten und eine unabhängig gegengeprüfte Timeline als Export einer konkreten echten Produktion. Das SQL erlaubt `claim_rejected` und Entscheidungsdaten, aber **ein manuell gespeichertes Ereignis ist keine unabhängige Tatsachenprüfung**.

IONOS-Backups und Beszel werden gemäß bestätigter Betreiberentscheidung weiterverwendet. Keine zusätzlichen Dienste, keine neue Backup-Diskussion und keine VPS-Änderungen durch diesen PR.
