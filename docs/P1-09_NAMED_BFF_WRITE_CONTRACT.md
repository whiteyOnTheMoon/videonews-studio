# P1-09 – Dormanter personenbezogener Web-BFF-Schreibvertrag

**Git/CI-only, Stand 25.10.2026:** Die tatsächliche Next.js-Route
`/api/admin/ai-providers` bleibt **GET-only**. Es gibt keinen
`POST`-Export, keinen gemounteten Eingabedialog, keine produktiven
API-Schlüssel und keine Datenbankverbindung für die Providerverwaltung.

Der ausschließlich mit synthetischem Fetcher getestete Vertrag
`dormantAdminAiProviderWriteProxy` in
`apps/web/src/lib/admin-ai-provider-write-contract.ts` wurde an die
persönliche Editor-Authentifizierung angepasst:

- **Nur persönliches Cookie:** ausschließlich
  `__Host-vns_editor`, exakt ein kanonisches Cookie. Das gemeinsame
  `__Host-vns_session` wird für Schreiboperationen nicht akzeptiert
  und niemals an den Anbieter-Schreibpfad weitergereicht.
- **Backend-Verifikation:** vor jeder Mutation fragt das BFF
  `/editor/me` über die bestehende, redigierte Editor-Proxyfunktion
  ab. Nur eine vom Backend bestätigte `admin`-Rolle mit validiertem
  Usernamen darf weitergehen. Der API-Handler prüft diese persönliche
  Sitzung beim eigentlichen Schreibaufruf **erneut**.
- **Origin und JSON-Grenzen:** strikter Browser-Origin, exakte
  Anbieter-/Modell-/Befehls-Whitelist, max. 1024 Body-Bytes,
  kanonische und bytegenau passende Content-Length, Ablehnung von
  Content-Encoding und ungültigem UTF-8. Zusätzliche Felder wie
  `editorId`, `role` oder frei wählbare Anbieter-URLs sind unzulässig.
- **Proxy-Antworten:** nur statusbasierte, generische Fehler; erfolgreicher
  Status ausschließlich `{ saved: true, active: false }`. Kein Secret
  oder upstream-Fehlertext geht an den Browser. Keine Redirect-Folge.
- **Isolierte Tests:** gemeinsames Admin-Cookie, ungültige persönliche
  Cookies und Nicht-Admin-Rollen, synthetische Credential-Weiterleitung,
  ungültige Payloads und Body-Formate, Upstream-Ablehnungen sowie
  Secret-Exfiltration. Separate Randfalltests für fehlerhafte
  Content-Length- und Content-Encoding-Header fehlen noch.

### Nicht abgenommen

Die Tests nutzen weder eine echte Browser-Sitzung auf dem VPS noch einen
produktiven PostgreSQL-Writer. Es gibt keine neue Route oder Umgebungsvariable,
die den Schlüssel-Schreibpfad aktiviert. Vor Freigabe fehlen echte
Least-Privilege-DB-Logins, sichere KEK-Custody/Recovery, kontrolliertes
privates Deployment, BFF-/API-End-to-End-Abnahme und separate
Kosten-/Budgetfreigabe. Offsite-Backups bleiben gemäß
Betreiberentscheidung vorerst vertagt; das ist ein dokumentiertes Risiko.
