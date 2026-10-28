# P1-09 / #230 — One-shot Provider-Dispatch-Claim (Offline)

**Git-only, standardmäßig deaktiviert. Keine produktive Migration, kein
Provider-SDK und kein HTTP-Aufruf.**

Migration 0039 erweitert die vorhandene SQL-Budgetkette 0036–0038 um
eine **einmalige, nicht zurücksetzbare Dispatch-Markierung** je
Reservierung. Das verhindert, dass ein zweiter oder paralleler
Worker dieselbe Reservierung erneut für einen potentiell
kostenpflichtigen Request beansprucht.

Die Funktion \`vns.claim_provider_live_dispatch(uuid)\` erlaubt den
ersten Claim nur bei aktivierter, nicht gestoppter Budgetpolicy,
vorhandener Reservierung, gültigem nicht abgelaufenem Preis-Snapshot
und noch ausstehendem Settlement. Alle Claims stehen unter dem
globalen Policy-Row-Lock. Die Folge \`reserve → claim → fixture →
receipt → settle\` ist im CI separat abgebildet.

**Wichtig:** Ein Timeout oder Worker-Absturz **nach** dem Claim erlaubt
keinen zweiten Versandversuch. Die Reservierung bleibt erhalten.
Unbekannte Anbieterantworten sind nicht automatisch kostenlos.
Die einmalige Markierung kann auch nicht durch eine Rolle mit
Provider-Writer-Funktionsrecht gelöscht werden.

### Nachweise

- \`db/tests/0039_provider_one_shot_dispatch_claim.test.sql\` prüft
  Default-off, ACLs, fehlende Reservierung, abgelaufene Preise,
  doppelte Claims, unveränderliche Datensätze und Settlement.
- \`db/tests/0039_provider_dispatch_claim_concurrency.setup.sql\`
  plus \`db/scripts/test_migrations.sh\` testen, dass zwei unabhängige
  PostgreSQL-Sitzungen um denselben Claim konkurrieren. Nur die
  erste darf eine UUID erhalten; die zweite muss \`NULL\` erhalten.
- \`provider-one-shot-fixture-dispatch.ts\` ist ein
  **netzwerkfreier** Offline-Pfad für bereits gespeicherte
  vendorförmige Testantworten. Er nimmt kein Callback entgegen und
  kann dadurch selbst keinen Provider-Aufruf auslösen.

### Warum das noch keine Freigabe echter Anbieteraufrufe ist

Die einmalige SQL-Markierung ist **keine echte Versand- oder
Rechnungsbestätigung**. Es fehlen der verbindlich integrierte und
überwachte Netzwerktransport, die echte Herkunftsauthentisierung
der Anbieterantwort, echte verifizierte Preise, das EUR-/FX-Gesamtlimit
und die Einbindung in alle möglichen Worker-Einstiegspunkte.
Ebenso muss geprüft werden, dass ein Client die SQL-Reservierung
nicht umgehen kann. Ohne alle Gates bleibt der Paid-Dispatcher aus.

Der bestätigte VPS-Schema-Stand war zuletzt 0018. Migration 0039
benötigt zwingend die vorherigen Migrationen 0019–0038 und wird
nur in isoliertem GitHub-CI PostgreSQL 17 ausgeführt.
Es wird keine Freigabe für einen Echtkosten-Canary erteilt.
