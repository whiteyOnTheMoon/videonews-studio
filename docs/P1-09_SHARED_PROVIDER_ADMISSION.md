# P1-09 – Gemeinsames Datenbank-Rate-Gate für Admin-Anbieteränderungen

**Stand: 25.10.2026. Git-/CI-only, kein VPS-Rollout, keine produktive Schlüsselannahme.**

## Technische Vorbereitung

Migration `0017_ai_provider_mutation_admission` erstellt eine einzige persistente
Zeile für einen globalen, datenbankseitigen Änderungszähler. Die neue
`SECURITY DEFINER`-Funktion `vns.admin_try_ai_provider_mutation_slot()`
reserviert durch `SELECT ... FOR UPDATE` höchstens fünf Versuche je
60-Sekunden-Fenster. Die Uhrzeit stammt vom Datenbankserver, nicht vom
HTTP-Client. Ein Rücksprung der Uhr gewährt keine weiteren Versuche.

Nur die bereits existierende **NOLOGIN**-Rolle
`vns_provider_config_writer` darf diese Funktion ausführen. Sie kann
die Zählertabelle weder lesen noch manipulieren. Die bestehende
API-Runtime-/Research-Rolle darf weder die Funktion ausführen noch die
Tabelle lesen. Der separate Funktions-Owner verfügt über den minimalen
Tabellenzugriff; bestehende Runtime-Rollen bekommen keine neuen Rechte.

`PostgresProviderMutationLimiter` ruft ausschließlich diese Funktion
über einen injizierten SQL-Pool auf. Der weiterhin *optionale, unmontierte*
`AdminProviderConfiguration`-Handler akzeptiert jetzt synchrone und
asynchrone Limiter. Bei Datenbankfehlern erfolgt eine generische
HTTP-503-Antwort; ausgeschöpfte Kapazität liefert HTTP 429. Beides
passiert **vor** dem Lesen eines Credential-Bodys und vor jeder
Konfigurationsmutation.

## Offline-Verifikation

- Migration, Rollback und Rollenrechte zweimal im separaten
  PostgreSQL-17-CI-Container.
- Zwei unabhängige SQL-Sitzungen konkurrieren gleichzeitig um insgesamt
  acht Versuche: fünf Zusagen, drei Ablehnungen, ein dauerhaft gespeicherter
  Zählerstand von fünf.
- TS-Fixtures prüfen streng typisierte DB-Antworten, Sperren,
  Datenbankausfälle und Geheimnis-freie HTTP-Fehler.
- Unabhängiger, synthetischer Full-Schema-/Global-Roles-Restore stellt
  die neue Zählertabelle, den Funktions-Owner und die EXECUTE-Grenze
  wieder her, ohne echte Schlüssel zu sichern.

## Nicht freigegeben

Das neue Gate ersetzt nicht die **personengebundene Audit-Zuordnung**,
MFA oder Genehmigung für Schlüsseloperationen. Der Zähler ist bewusst
global für alle späteren Admins, nicht pro Benutzer. Der neue
Provider-Pool darf nur mit einer separat freizugebenden least-privilege
LOGIN-Rolle erstellt werden; aktuell gibt es **keine** solche
Produktionsverbindung. `apps/api/src/index.ts` injiziert nach wie vor
keinen Provider-Handler. Web-BFF-POST, API-Key-Formular, Gemini/OpenAI-
Aufrufe und Abbuchungen bleiben inaktiv.

Diese SQL-Migration wird ausschließlich in GitHub CI erprobt.
Kein VPS-Datenbankeingriff, kein Docker-/Beszel-Neustart und keine
Einrichtung kostenpflichtiger Dienste oder Backups. Der Betreiber hat
das unabhängige Offsite-Backup weiterhin ausdrücklich vertagt.
