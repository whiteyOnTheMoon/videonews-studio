# P2-01: Single-Owner-Freigaben mit persönlichem Audit (0061)

**Status:** Sicherheitsmodell in GitHub vorbereitet. Migration 0061 ist **nicht** auf dem VPS ausgerollt. Keine Feedquelle ist dadurch freigegeben.

## Entscheidung

VideoNews Studio wird derzeit von einer einzigen realen Person als Owner, Projektmanager und verantwortlichem Redakteur betrieben. Der Owner darf beide Entscheidungen selbst treffen: erst die Prüfung/Freigabe einer Quelle einschließlich Nutzungsrechten, danach die gesonderte Freigabe des zugehörigen Feed-Hosts. Es darf kein zweiter Prüfer erfunden werden.

Die ursprünglich in Migration 0023 verlangte zweite menschliche Identität ist eine von uns festgelegte technische Governance-Regel, keine für das Projekt nachgewiesene gesetzliche Vorschrift. Für einen Einpersonenbetrieb ist eine ausdrücklich autorisierte Alternative sachgerecht.

## Umsetzung und Grenzen

Migration 0061 legt `vns.single_owner_review_policy` mit **enabled=false** und ohne Owner-ID an. Die Tabelle ist ausschließlich für eine gesondert geprüfte DBA-/Betreiber-Konfiguration beschreibbar, nicht für API, Worker oder den benannten Redakteur-Client. Bei fehlender Policy bleibt die alte Zwei-Menschen-Sperre wirksam.

Der Einpersonenfall ist nur erlaubt, wenn gleichzeitig alle Bedingungen erfüllt sind:

- Der Operator hat die exakte persönliche Owner-ID separat in der Datenbank-Policy eingetragen und den Single-Owner-Betrieb mit einer nachvollziehbaren Begründung freigeschaltet.
- Das aktive PostgreSQL-`session_user` ist exakt die persönlich registrierte Loginrolle dieser Owner-ID; ein gefälschter HTTP-Akteur, ein geteilter Writer oder `SET ROLE` genügen nicht.
- Die aktuelle Quellenfreigabe ist bereits persönlich und revisionsgebunden auditiert; der Source-Audit-Verlauf weist denselben Owner als tatsächlich freigebenden Redakteur aus.
- Eine neue Hostfreigabe erfordert weiterhin die aktuelle Quellenrevision, expliziten Host, eine gesonderte Begründung, CAS, maximal fünf Hosts und die bisherigen SSRF-/URL-Prüfungen.

Das unveränderliche Host-Audit erhält `approval_model` = `single_owner` oder `two_person`. Eine einzelne Person wird **nicht** als unabhängiger Zweitprüfer ausgewiesen. Änderungen an Quellenregister oder Host-Zustand entwerten weiterhin alte Autorisierungen.

Weder die Policy noch die Migration autorisieren automatisch echte Nachrichtenquellen, machen Lizenzen gültig, starten Feeds oder erlauben Veröffentlichungen. Nutzungsbedingungen, Attribution und die konkrete Reichweite der Quellenrechte müssen vom Owner geprüft und mit Quellen-/Hostbegründungen belegt werden.

## Prüfung vor Rollout

`db/tests/0061_single_owner_review_policy.test.sql` kontrolliert in einem isolierten PostgreSQL mit fiktiven Personen und URLs:

- **Default-off:** Ein Owner kann seinen eigenen Host ohne aktivierte Policy nicht freigeben.
- **Auditierter Solo-Modus:** Nach DBA-Policy-Freigabe dürfen Quelle und Host demselben persönlichen Login gehören; die zwei Entscheidungen und das sichtbare `approval_model` bleiben getrennt.
- **Keine Identitätsfälschung:** Ein fremder Login mit alten Host-Writer-Rechten kann die Owner-ID nicht behaupten.
- **Kein Client-Policy-Schreiben**, keine ungültige Host-Revision und keine weitere Nutzung nach Widerruf des Owner-Logins.

Die CI läuft in einem vergänglichen Container und setzt Migration 0061 danach zurück. Der produktive VPS bleibt auf 0059, solange eine getrennte Migration und API-Runtime-Abnahme fehlen.

## Weiterer Lieferumfang

Anschließend wird eine ausschließlich persönlich gebundene Source-/Host-API in `apps/api/src/index.ts` aktiviert, ohne gemeinsamen Writer. Für den produktiven Solo-Modus wird eine separate, protokollierte Owner-Policy-Einrichtung benötigt, die nur nach gesicherter Lizenzprüfung die Hostfreigabe erlaubt.

**Keine Zwei-Personen-Pflicht für den alleinigen Owner, aber weiterhin persönliche Verantwortung, transparente Begründungen und technische Sperren.**
