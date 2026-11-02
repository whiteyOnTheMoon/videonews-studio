# P2-03 – Monotoner Watchdog für den dauerhaften Feed-Consumer

**Status:** GitHub-Code und isolierte CI, kein VPS-Rollout und keine
Aktivierung echter Nachrichtenquellen.

## Behebung

Der bestehende Consumer verwendete `Date.now()` für die maximale
Joblaufzeit. Bei einem Uhrzeitrücksprung verlängerte sich der
Watchdog unbeabsichtigt. Bei einem Redis-Fehler, einem hängenden Job
oder einem `stalled`-Ereignis wurde zwar der Abbruch angefordert,
der zuvor veröffentlichte `ready`-Status konnte bis zum
nachfolgenden Shutdown noch bestehen bleiben.

Der neue `feed-consumer-job-health-guard.ts` verwendet
`performance.now()` für die Jobdauer, überwacht die
Berechtigungsgrenze des Workers und veröffentlicht bei folgenden
Ereignissen **unmittelbar `stopped`** in die vorhandene private
0600-Docker-Health-Datei:

- Einzeljob erreicht den expliziten 30–600-Sekunden-Watchdog,
  einschließlich einer verspäteten `completed`-Antwort
- Drei aufeinanderfolgende fehlgeschlagene Jobs
- `stalled`-Signal, Redis-/BullMQ-Fehler oder ungültige
  Job-Statusübergänge
- Rückwärtslaufende oder ungültige monotone Uhr sowie
  fehlgeschlagener Heartbeat-Schreibvorgang

Ein erfolgreich abgeschlossener Job setzt den Fehlerzähler zurück.
Der Consumer meldet erst nach `worker.waitUntilReady()` einen
`ready`-Status. Die getrennte Producer-Identität, bestehenden
Redis-ACLs, Quellen-Signaturprüfung, Revisionsanker und
PostgreSQL-Berechtigungen bleiben unverändert. Für einen
unerwarteten Redis-Ausfall erfolgt kein unbeschränktes
`QUIT`-Warten, sondern ein lokales `disconnect()`.
Es gibt weiterhin **keinen automatischen Neustart**.

## Nachweis und Grenze

Die CI verifiziert deterministische Job-Übergänge, genau
am Timeout abschließende Jobs, drei konsekutive Fehler,
Uhrzeitrücksprung, fehlgeschlagene Statusdatei und einen
tatsächlich gespeicherten 0600-Heartbeat, der bei Watchdog-Stopp
unmittelbar ungesund wird.

Das Abbrechen eines BullMQ-Arbeiters kann einen bereits
festhängenden asynchronen Job nicht technisch rückgängig machen.
Der neue Schutz kennzeichnet den Zustand ungesund und fordert
Abbruch an, statt trotz fehlender Fortschritte weiter
`ready` zu behaupten. Produktiver Restart-/Alarmnachweis,
Rechtefreigaben der Nachrichtenquellen und ein unabhängig
verwalteter Anker bleiben separat abzunehmen.
