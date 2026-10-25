# P1-09 – Dauerhafte, aber ausschließlich synthetische KI-Budgetreservierungen

**Status: Nur Repository/CI, nicht auf dem VPS ausgerollt.**
Die Migration `0014_synthetic_ai_budget_reservations` ergänzt die vorangegangene
rein synthetische Token-Belegmigration `0013`. Sie ist kein Live-Budgetschutz,
keine Abrechnung und keine Erlaubnis, OpenAI oder Gemini aufzurufen.

## Ziel und Schutzmechanismus

Eine Budgetreservierung ist eine **dauerhafte, transaktionale Vormerkung**
für eine einzige geplante Text-Anfrage eines bekannten `vns.jobs`-Jobs.
Jeder bekannte synthetische Anfragebezeichner `(job_id, provider, request_id)`
darf nur einmal reserviert werden. Die Funktion
`vns.reserve_synthetic_ai_budget(job_id, request_id, stage, model,
max_input_tokens, max_output_tokens, budget_day)`
berechnet den maximalen hypothetischen Textpreis ausschließlich aus einer
fest kodierten, datierten Offline-Tabelle – der Aufrufer kann keine Preise
oder Geldbeträge einschleusen.

**Der Funktionsaufruf führt keine KI-Anfrage aus.**
Es gibt keine API-Keys, keine Netzverbindung, kein automatisches Starten eines
Workers, keine DB-Rollenfreigabe an bestehende Anwendungen und keinen
neuen Docker-Dienst. Nur der isolierte CI-Datenbankeigentümer kann
synthetische Reservierungen erstellen.

## Grenzen (Vorschlag, keine freigegebene Ausgabe)

| Grenze | Betrag |
| --- | ---: |
| Pro synthetischer Textanfrage | 100.000 Mikro-USD = $0,10 |
| Pro Job und synthetischem Kalendertag | 250.000 Mikro-USD = $0,25 |
| Gemeinsam für alle Jobs je synthetischem Kalendertag | 2.000.000 Mikro-USD = $2,00 |

Die drei englischen Stufen und ihre Höchsttokenzahlen entsprechen
`ai-provider-policy.ts`: `topic_triage` mit `gpt-6-luna`,
`script_draft` und `fact_audit` mit `gpt-6.1-sol`.
Die numerischen Preise sind fest und mit Datum **25.10.2026** versehen.
Vor jeder zukünftigen realen Anfrage müssen Modellverfügbarkeit,
Providerpreistabellen und Gebührenarten unabhängig neu geprüft werden.

Die Transaktion initialisiert bei Bedarf einen Tageszähler und sperrt
dessen Datensatz mittels `SELECT ... FOR UPDATE`. Damit müssen gleichzeitig
eintreffende Anfragen des **gleichen Tages** die Prüfung der Tagesgrenze
nacheinander bestehen. Vor der Erhöhung prüft sie, ob die Anfrage bereits
vorhanden ist: ein identischer Retry liefert dieselbe Beleg-ID **ohne
zusätzliche Reservierung**; ein Retry mit geändertem Tokenrahmen, Modell,
Stufe oder Datum scheitert. Außerdem wird pro Job/Tag über sämtliche
bisherigen Reservierungen summiert.

Alle Beträge werden mit PostgreSQL-`numeric` berechnet und als ganzzahlige
Mikro-USD nach oben gerundet. Die Tageszähler und Reservierungen bleiben
in PostgreSQL erhalten, bis der **explizit nur für die disposable CI
bestimmte** Rollback ausgeführt wird. Die History verweigert Änderungen,
Löschung und TRUNCATE. Reservierungen werden **nie automatisch
freigegeben oder abgerechnet**; unklare Ergebnisse bleiben konservativ
reserviert. Ein Postgres-Superuser kann Trigger verändern – dies ist
also kein Schutz vor einem privilegierten Administrator.

## Echte Konkurrenztests nur in GitHub Actions

`db/tests/0014_synthetic_ai_budget_reservations.test.sql` testet
idempotente Retries, Beträge, modifizierte Wiederholungen,
Tages-/Job-/Anfragegrenzen, negative Testeingaben,
append-only-Schutz und fehlende Runtime-Rollenrechte.

`db/scripts/test_migrations.sh` startet ausschließlich unter
`GITHUB_ACTIONS=true` und `CI=true` einen isolierten PostgreSQL-17-Container.
Zwei getrennte Datenbanksitzungen reservieren parallel $0,09, obwohl
nur noch $0,11 Tagesbudget übrig sind: **genau eine muss erfolgreich sein**,
und der Tageszähler darf danach nur einmal steigen. Ein zweites paralleles
Paar wiederholt dieselbe Anfrage und muss exakt dieselbe Reservierungs-ID
zurückgeben. Der Test ist nicht auf den VPS anzuwenden.

Zusätzlich enthalten der komplett neu aufgesetzte unabhängige
`test_full_restore.sh`-Drill und der Tabellenfingerprint jetzt
Migration 0014, einen synthetischen reservierten Tagesbetrag sowie
Negativprüfungen auf Rechte und inkonsistente Wiederherstellung.

## Was das ausdrücklich NICHT absichert

- Ein reales OpenAI-API- oder Gemini-TTS-Konto und dessen Gebühren.
- Token-Aufschläge durch Tools, Audio, Caching, Reasoning,
  Preise über Kontextgrenzen oder unbekannte neue Modellversionen.
- Wiederholte **tatsächliche** Provider-Aufrufe nach Netzwerkfehlern.
- Durch einen Aufrufer manipulierte Buchungsdaten: `budget_day` wird
  **synthetisch vom Test vorgegeben**, nicht aus einer vertrauenswürdigen
  Uhr oder vom Provider abgeleitet. Ein Live-System benötigt eine
  authentifizierte serverseitige Zeitquelle und eindeutige Budgetperiode.
- Zeitlich ablaufende Reservierungen, Settlement, Freigabe,
  Preisnachbuchungen oder Refunds; diese fehlen bewusst.
- Eine betrieblich eingerichtete, mit begrenzten Rechten authentifizierte
  Buchungsrolle. Bestehende API-/Workerrollen erhalten keinen Zugriff.
- Echte Backup-, Restore- oder Notfallgarantien auf dem VPS.

**Freigabegrenze:** Vor echter Nutzung sind ein separat geprüfter
Provider-Adapter, autorisierte Budget-/Zeitidentität, langlebige
atomare Reservierung **vor jedem Provider-Aufruf**, Behandlung
ungewisser Kosten bei Timeouts, tatsächliche Anbieterbelege und eine
durchsetzbare Gesamtkontrolle über Text und TTS erforderlich.
Die Entscheidung, vorerst ohne unabhängiges Offsite-Backup zu arbeiten,
wird nicht durch diesen CI-Restore-Test aufgehoben. Beszel bleibt
das bestehende gemeinsame VPS-Monitoring.

Issue #9 bleibt offen.
