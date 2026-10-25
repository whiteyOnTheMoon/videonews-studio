# P1-09 – Inaktiver geschützter Admin-Schreibvertrag für KI-Anbieter

**Stand: 25.10.2026. Kein produktiver API-Key-Eingabedialog. Keine
Provider-Aktivierung. Keine Laufzeitroute, keine Migration und keine
Änderung am VPS.**

Die zukünftige Admin-Seite **KI-Anbieter** soll OpenAI-/Gemini-API-Keys
ohne Hardcoding annehmen, ersetzen und löschen sowie Modelle auswählen.
Dazu ergänzt der Git-only-Baustein
`apps/web/src/lib/admin-ai-provider-write-contract.ts` den bereits
vorhandenen *read-only* BFF um einen **isoliert testbaren,
nicht angeschlossenen** Schreibvertrag.

## Was der Vertrag heute testet

Die Funktion `dormantAdminAiProviderWriteProxy(request, config, fetcher)`
ist **nicht** in einer Next.js-Route registriert. Weder
`/api/admin/ai-providers` noch eine andere produktive Route importiert
sie. Es gibt weiterhin **keine** POST-Methode im laufenden BFF.

Erst wenn ein separat zu genehmigender Backend-/Betriebsrollout erfolgt,
muss ein späterer Administrator-Schreibaufruf alle folgenden Prüfungen
bestehen:

- Eine durch separate Freigabe verfügbare **serverseitige** Proxykonfiguration,
  die auf den intern erlaubten API-Host `api:4000` bzw. Loopback und die
  exakt festgelegte öffentliche HTTPS-Origin verweist.
- Die Anfrage muss **POST** und denselben exakten Origin-Header verwenden.
  Andere Methoden oder fehlender/fremder Origin schlagen fehl.
- Das eindeutige formal gültige Admin-Session-Cookie muss vorhanden sein;
  die bestehende interne `GET /admin/me`-Prüfung muss die Rolle
  `admin` bestätigen. Eine Browser-Angabe `role:admin` zählt nicht.
- Maximal **1024 Bytes UTF-8-JSON** mit `Content-Type:application/json`.
  Nur `set_key`, `remove_key`, `set_model` mit exakt erlaubten
  Feldern, Anbieter- und Modell-Allowlist, druckbarem 12–512-Zeichen-Key.
  Zusatzfelder, benutzerdefinierte Ziel-URLs, `enable` und
  `test_connection` werden verweigert.
- Der Key würde **erst nach allen Prüfungen** an die festgelegte
  interne API weitergereicht. Der BFF darf keine Keys in Cookies, URLs,
  Dateien, Logzeilen, Statusantworten oder clientseitigem Speicher
  hinterlegen. Der interne API-Vertrag aus PR #210 ist weiterhin
  *nicht* aktiviert.
- Nur eine exakte Backend-Antwort `{saved:true,active:false}` darf nach
  außen als Erfolg erscheinen. Anbieterschlüssel, Ciphertext,
  unbekannte Felder, Redirects oder Backend-Fehler werden nicht
  übernommen. Antworten erhalten `Cache-Control:no-store`.
- Eine persistente API-Key-Speicherung ist ohne freigegebenen
  Master-Key, auditierte Datenbankrolle und individuell zugerechnete
  Administratoranmeldung **nicht erlaubt**.

## Verbindliche offene Sicherheitsarbeit vor echten Eingaben

Die nächsten Phasen müssen serverseitig rate-limitiertes Schreiben,
einen sicheren initialen Docker-Secret-Mount, Rechte auf eine
separate Datenbankrolle, auditierte Admin-Identitäten und
validierte BFF-/API-Ende-zu-Ende-Tests implementieren. Ein bloßes
Setzen einer Feature-Flagge genügt dafür **nicht**.

**Wichtige technische Grenze:** Die Browser- und Node.js-Laufzeiten
können Kopien des eingegebenen API-Keys im Speicher halten;
temporäres Überschreiben von Bytearrays löscht nicht garantiert
alle Strings oder HTTP-Puffer. Darum dürfen in der Zukunft weder
Request-Bodies geloggt noch Fehlerdetails ungeprüft weitergereicht
werden. Zusätzlich müssen Referrer, Browser-Persistenz und
Webserver/Reverse-Proxy-Logging geprüft werden.

Die Mock-Tests in `apps/web/src/lib/admin-ai-provider-write-contract.test.ts`
testen ausschließlich erfundene Schlüssel, erlaubte Kommandos,
falsche Ursprünge/Cookies, fehlende Admin-Rollen, fremde Modelle,
überlange Körper, Redirects und Geheimnisschutz. **Kein echtes
Konto oder API-Endpunkt wird kontaktiert.**

Die explizite Entscheidung, **vorerst ohne Backup** weiterzuarbeiten,
wird nicht aufgehoben. Damit bleiben Datenverlust und der Verlust
des künftig separat zu verwahrenden Master-Keys ein bewusstes Risiko.
Es wurde kein Backupdienst installiert und keine KI-Ausgabe freigegeben.
