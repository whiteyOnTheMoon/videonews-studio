# P1-09 – Optionaler API-Dispatch, weiterhin abgeschaltet

Der API-Server kann einen explizit injizierten `AdminProviderConfiguration`-Handler für
`/admin/ai-providers` aufrufen. Ohne den Handler bleibt der Pfad bei HTTP 404.
`apps/api/src/index.ts` übergibt **keinen** Provider-Handler. Die echte Anwendung,
der Web-BFF und das unmontierte Formular bleiben unverändert.

Der Server verlangt eine bestehende Admin-Auth-Abhängigkeit, ehe ein Provider-Handler
injiziert werden kann. Ein separater Test prüft 404 ohne Handler sowie diesen Startfehler.
Die vorherigen synthetischen Vertrags-, Verschlüsselungs- und SQL-Tests bleiben erhalten.

Das ist **keine** Aktivierung: kein eigener Runtime-DB-User, keine Master-Key-Datei,
kein persönliches Mutationsaudit, kein verteiltes Rate-Limit, keine Credentials, keine
Live-KI-Aufrufe, keine Migration und keine VPS-/Docker-Änderungen. Ein bloßes
manuelles Injizieren genügt keinesfalls zur sicheren Produktionsfreigabe;
die Betriebs- und Wiederherstellungsvoraussetzungen in Issue #9 bleiben offen.
