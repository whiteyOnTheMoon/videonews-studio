# P1-09 – Persönliche Admin-Sitzung bis zum inaktiven Provider-HTTP-Handler

Die neue Klasse `NamedAdminProviderConfiguration` verbindet ausschließlich in
isolierten Tests die bestehende persönliche Redakteursanmeldung mit dem
benannten SQL-Audit-Adapter. Die produktive `apps/api/src/index.ts`
instanziiert **keinen** Provider-Handler und registriert **keine**
Key-Eingabe. Im laufenden System bleibt die Route unverändert gesperrt.

## Sicherheitsgrenzen

- **Nur die echte persönliche Editor-Sitzung:** Die Identität kommt
  ausschließlich aus `EditorAuth.authenticatedAdminIdentity(request)`.
  Shared-Admin-Cookies, JSON-Felder, URLs und freie Header werden nicht zur
  Identitätsquelle. Rollen und Session-Version werden bei jedem Request
  gegen den aktiven Account geprüft.
- **Kein Legacy-Writer:** Der neue Handler besitzt nur das Interface
  `mutateAsNamedAdmin(change, identity)`. Er kann nicht über
  `mutateWithAudit` den alten Shared-Session-Pfad benutzen.
- **Pflichtlimit:** Ein injizierter asynchroner Rate-Limiter ist zwingend.
  Ohne Quotenbestätigung oder bei Datenbankfehlern wird der Request
  vor dem Lesen eines möglichen Credential-Bodys abgewiesen.
- **CSRF- und Inhaltsvalidierung:** POST benötigt den bekannten HTTPS-Origin
  sowie die bestehenden strikten JSON-/UTF-8-/Byte-Längenprüfungen.
- **Geheimnisse:** Der Handler verschlüsselt synthetische Schlüssel vor
  dem Aufruf des benannten SQL-Stores. Antworten bleiben generisch und
  enthalten weder Key noch SQL-/Crypto-Diagnostik. GET zeigt nur
  das öffentliche Provider-Metadatenformat und stets `active:false`.
- **Separater Server-Dispatch:** Auch das optionale Test-Mount benötigt
  einen EditorAuth-Handler zusätzlich zu den bereits bestehenden
  Admin-/Job-Gates. Ohne Injektion bleibt HTTP 404.

## Kein Produktions-Rollout

Weder `index.ts`, der Web-BFF noch die Admin-Seite werden umgestellt.
Keine DB-LOGIN-Rolle, kein KEK-Provisioning, keine realen Secrets, keine
kostenpflichtigen Provider, keine DB-Migration auf dem VPS und kein
Offsite-Backup. Die atomare DB-Validierung der aktiven Admin-Rolle bleibt
auf Migration 0018 beschränkt; vor produktiver Nutzung sind die
least-privilege Verbindung, KEK-Wiederherstellung, persönliche
HTTP-/BFF-Session-Durchleitung und Deployment-Abnahme erforderlich.
