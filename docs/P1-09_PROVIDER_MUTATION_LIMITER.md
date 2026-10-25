# P1-09 – Testbare Rate-Gate-Grundlage für gesperrte Schreibbefehle

`ProviderMutationLimiter` begrenzt in einem **einzelnen Node-Prozess**
Schreibversuche über einen gemeinsamen Zähler auf fünf Versuche pro Minute.
Ungültige oder rückwärts laufende Uhren sperren weitere Versuche. Die
Testuhr lässt Grenzfälle ohne Zeitverzögerungen prüfen.

Die optionale Injektion in `AdminProviderConfiguration` erlaubt Tests,
die die Sperre **vor** dem Lesen des Credential-Bodys und **vor** jeder
Datenbankänderung nachweisen. Der produktive Einstiegspunkt `index.ts`
erzeugt weiterhin **keinen** Provider-Konfigurationshandler.

**Dies ist kein produktionsfähiges Rate-Limit.** Bei mehreren API-Prozessen
werden Zähler nicht synchronisiert, und ein Neustart löscht den Zähler.
Vor einer echten API-Key-Eingabe sind daher ein instanzübergreifender,
atomarer Limit-Store, persönliche Admin-Zuordnung, auditierte DB-Rolle,
geschützte KEK-Datei samt Recovery und eine ausdrückliche Betriebsfreigabe
notwendig. Keine Kosten, neuen Dienste, Migrationen oder Backups.
