# P1-09 – Vorbereitung personenbezogener Anbieter-Audits

**Nur Repository und isolierte CI. Keine produktive Freischaltung.**

Migration 0018 erweitert das bisherige gemeinsame Admin-Audit um ein eigenes, nicht editierbares Ereignisjournal. Der neue SQL-Schreibpfad prüft unter Zeilensperre, dass die übergebene Redakteurs-ID zu einem aktiven Admin mit der aktuellen `auth_version` gehört.

- Der neue Datenbankpfad validiert aktive Admin-Rolle und Session-Version unter einer Accountsperre.
- Bei Erfolg erfolgen die bereits geprüfte Anbieteränderung und das benannte Audit in einer Transaktion.
- Der unveränderte Legacy-Audit-Eintrag bleibt absichtlich zusätzlich erhalten.
- Der unprivilegierte Provider-Writer kann die ältere gemeinsame Schreibfunktion nicht mehr ausführen.
- Bestehende API-/Research-Rollen dürfen die neue Funktion nicht ausführen.
- Die Funktion hat einen separaten NOLOGIN-Eigentümer und speichert keine API-Schlüssel.
- Das Journal hält ID, Datenbank-basierten Benutzernamen, Session-Version und Operation fest.
- Ein neuer TypeScript-Adapter nutzt nur den benannten SQL-Vertrag für mutierende Aufrufe.
- `EditorAuth.authenticatedAdminIdentity` liefert die serverseitig überprüfte Identität.
- Offline-Tests decken Rollenwechsel, inaktive Konten, veraltete Versionen und unzulässige Modelle ab.

## Entscheidende Vertrauensgrenze

**Die Datenbank kann eine vom aufrufenden Service behauptete Editor-ID nicht selbst kryptografisch einer Browser-Sitzung zuordnen.** Die neue Funktion prüft zwar den aktuellen Admin-Datensatz, aber noch nicht den Ursprung der übergebenen Identität. Deshalb dürfen die benannten SQL-Funktionen und der Adapter erst verwendet werden, wenn der Server die Identität ausschließlich über die echte, aktive persönliche Redakteurssitzung ermittelt. Eine Client-ID oder ein Username aus JSON, Query-Parametern oder Headers ist ausdrücklich unzulässig.

Der produktive API-Einstiegspunkt und die Web-Oberfläche rufen den neuen Pfad **nicht** auf. Die derzeitige gemeinsame Admin-Sitzung ist keine persönliche Identität. Weitere Arbeit ist erforderlich, um die persönliche Sitzung, BFF, API-Schreibpfad, Rate-Limit und atomare Auditierung sicher zusammenzuschalten.

## Getestet, nicht produktiv abgenommen

Migrationen und Rollback werden in frischem CI-PostgreSQL getestet. Ein separater synthetischer Full-Schema-Restore kontrolliert Rollen und Funktionsrechte. Diese Tests ersetzen weder VPS-Deployment noch Offsite-Backup oder einen echten Wiederherstellungstest. Keine echten Zugangsschlüssel, keine API-Aufrufe und keine kostenpflichtigen KI-Jobs.
