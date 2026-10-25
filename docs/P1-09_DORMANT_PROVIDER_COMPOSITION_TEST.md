# P1-09: Isolierter API-/SQL-Vertragstest (keine Aktivierung)

Stand 2026-10-25. Dieser Schritt verbindet **ausschließlich im Node-Testprozess**
den bestehenden `AdminProviderConfiguration`-HTTP-Vertrag mit dem bestehenden
`PostgresProviderConfigStore`-Adapter über eine injizierte Fake-`Pool.query`.

Der Test `apps/api/src/admin-provider-composition.test.ts` deckt ab:

- secret-freie Statusantwort mit zwingend deaktivierten Anbietern;
- synthetischen Key: AES-GCM-Versiegelung vor der parametrisierten SQL-Funktionsgrenze;
- Ablehnung ungültiger Session, falscher Origin und nicht erlaubter Aktivierung **vor SQL**;
- generische 503-Antwort ohne interne Datenbank-Fehlerdetails.

**Grenzen:** Die Fake-Pool-Aufrufe sind kein PostgreSQL-End-to-End-Lauf,
keine echte DB-Rollen- oder Audit-Transaktionsprüfung und kein Beweis
einer korrekt provisionierten KEK-Datei. SQL-Migrationstests und isolierte
Role/Restore-Tests bestehen als eigene Prüfflächen weiter.

Insbesondere wird weder `server.ts` noch eine Next.js-Route oder
das Admin-Dashboard geändert. Keine produktive Anmeldung, Persistenz,
Schlüsselannahme, API-Verbindung, kostenpflichtige KI-Anfrage, DB-Migration,
Backups oder VPS-/Docker-/Beszel-Änderung. Das Formular bleibt unmontiert,
Provider sind weiterhin deaktiviert.

Vor produktiver Nutzung fehlen weiterhin eigene privilegierte Runtime-Identität,
persönliche Audit-Zuordnung, Rate-Limits, sicherer KEK-Betrieb samt
Wiederherstellung, kontrollierter Rollout und reale Kosten-/Budget-Gates.
Issue #9 bleibt offen. Die bewusst vertagte Offsite-Backup-Entscheidung
wird nicht verändert.
