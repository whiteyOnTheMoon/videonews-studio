# P2-02 – Diagnose der Feed-Fehlerphasen

Der erste Live-Canary akzeptierte Quellenrevision 8, Hostrevision 7 und den lokalen Anker. Er erstellte den richtigen Checkpoint und drei PostgreSQL-Poll-Leases, aber keine Nachrichtenkandidaten. Die Ursache ist noch unbekannt.

## Datensparsame Diagnose

Der optionale Poll-Callback meldet nur geprüfte Source-IDs und feste Fehlerphasen:

- `source_grant`: Quellenfreigabe vor dem Lease abgelehnt
- `lease_claim`: SQL-Poll-Lease fehlgeschlagen
- `lease_validation`: Token oder HTTP-Validator ungültig
- `source_grant_before_https`: Freigabe vor HTTPS zurückgezogen
- `https_transport`: DNS, TLS, HTTP, Antworttyp oder Größenlimit abgelehnt
- `feed_decode`: RSS, Atom oder Metadaten ungültig
- `source_grant_before_commit`: Freigabe vor SQL-Commit zurückgezogen
- `metadata_commit`: Metadatenpersistenz abgelehnt

Es werden keine URLs, Passwörter, IPs, XML-Daten, vollständigen Antworten oder SQL-Fehler ausgegeben. Fehlgeschlagene Jobs bleiben fehlgeschlagen.

Die Diagnose ist standardmäßig deaktiviert. Für einen separat bestätigten, einmaligen Live-Lauf kann sie mit `VNS_FEED_POLL_STAGE_DIAGNOSTICS=true` aktiviert werden. In Offline-Tests und dauerhaften Consumern bleibt sie aus.

## Nach dem ersten Canary

Checkpoint, SQL-Leases und BullMQ-Jobs nicht löschen oder zurücksetzen. Ein neuer Canary darf erst nach Ablauf der bestehenden Poll-Intervalle und mit frischem Queue-Slot erfolgen. Da der Checkpoint bereits vorhanden ist, muss `VNS_FEED_SOURCE_BOOTSTRAP=false` gesetzt werden.

Dieser Patch beweist weder eine funktionierende HTTPS-Verbindung noch erfolgreiche RSS-Verarbeitung auf dem VPS.
