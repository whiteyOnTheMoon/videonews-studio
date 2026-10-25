# P1-09 – Admin-API-Vertrag für Anbieter-Credentials (nur isolierte Tests)

**Stand: Oktober 2026.** VideoNews Studio soll KI-API-Keys, Modellwahl
und später Stimme/Budget im passwortgeschützten Admin-Bereich verwalten.
Die vorangegangene Migration 0015 legt nur die deaktivierte Datenstruktur
an; der neue `AdminProviderConfiguration`-Vertrag ist noch **nicht** in
`apps/api/src/server.ts` oder `apps/api/src/index.ts` eingebunden.
Deshalb existiert auf dem VPS keine neue erreichbare API-Route.

## Simulierte Schnittstelle

Ein zukünftiger interner `GET /admin/ai-providers` liefert je Anbieter
nur `provider`, `selectedModel`, `configured` und `active:false`.
Ein späterer `POST /admin/ai-providers` akzeptiert genau eine der Aktionen:

- `set_key`: erlaubten Anbieter und ein einmalig eingegebenes `apiKey`.
  Die API versiegelt den Key sofort über die vorhandene AES-256-GCM-
  Funktion. Nur der Ciphertext und eine zufällige Nonce werden über die
  getrennte Store-Schnittstelle weitergereicht.
- `remove_key`: löscht den Credential-Eintrag nach eigenständiger Freigabe.
- `set_model`: erlaubt ausschließlich aktuell festgelegte Modellkennungen
  (`gpt-6-luna`, `gpt-6.1-sol`, `gemini-3.8-flash-tts`).

Es gibt absichtlich **kein** `enable_provider`, keine beliebigen URLs,
keine Nutzer-Prompts und keine echten Anbieter-Aufrufe. Die Antwort auf
erfolgreiche Mutationen enthält ausschließlich `saved:true,active:false`,
niemals den Key oder einen entschlüsselten Teil davon.

Die API-Klasse benötigt die existierende serverseitige Admin-
Sessionprüfung und für alle Schreibaktionen zusätzlich dieselbe
Origin/CSRF-Prüfung. Methoden, JSON-Felder und Körpergröße sind
begrenzt. Ungültige Daten, unberechtigte Anfragen und Backend-Fehler
werden ohne Weitergabe sensibler Daten abgelehnt.

## Sicherheitsgrenze zur echten Datenbank

`ProviderConfigStore` ist absichtlich nur ein abstrakter Adapter.
Ein künftiger PostgreSQL-Adapter muss Credential-Speicherung und
ein **secretfreies Auditereignis innerhalb derselben Transaktion**
schreiben (damit Rotation, Löschung und Modelländerung dokumentiert sind).
Es darf keine Schlüssel im Klartext zurückgeben.

Die Tests verwenden eine In-Memory-Testimplementierung und zufällige
Schlüssel aus `node:crypto`. Sie prüfen Admin/Origin-Sperren, korrekt
gebundene Verschlüsselung, Rotation, unzulässige Provider-/Modellkombinationen,
verbotene Aktivierungsbefehle, Begrenzung des Körpers und dass die
öffentlichen Antworten keine Credential-Daten enthalten.

**Nicht vorhanden/aktiviert:** echte Admin-Formulare, Web-BFF-Proxy,
PostgreSQL-Schreibadapter, Master-Key-Docker-Secret, API-Routen im
Produktivserver, Migration 0015 auf dem VPS oder echte Zugangsdaten.

Die folgenden Schritte erfordern eigenständige Tests und Freigabe:
eine dedizierte Least-Privilege-Datenbankrolle, transaktionales Audit,
geschützte Master-Key-Verwaltung inklusive Wiederherstellung/Rotation,
Browser-UI mit CSRF-sicherem BFF und strenge Spend-Gates.
Das absichtlich zurückgestellte Offsite-Backup bleibt ein Risiko.

Die echte Aktivierung eines KI-Anbieters bleibt bis zu einer
ausdrücklichen Budget- und Providerfreigabe unmöglich.

## Geprüfte SQL-Speichergrenze (Folgeschritt 0016)

Siehe [transaktionaler, inaktiver Anbieter-Audit-Speicher](P1-09_ADMIN_PROVIDER_AUDIT_STORE.md).
Der neue Adapter nutzt ausschließlich parametrisierte SQL-Funktionen mit
zugeordnetem Audit. Es gibt weiterhin **keine** produktive Route, Browser-
Key-Eingabe, Master-Key-Bereitstellung oder neue Laufzeitberechtigung.

## Browser-Vorschau ohne Key-Eingabe (Folgeschritt)

Die [schlüssel- und schreibfreie KI-Anbieter-Vorschau](P1-09_ADMIN_AI_PROVIDERS_PREVIEW.md)
verwendet das vorhandene Admin-Session-Gate und einen separat deaktivierten
GET-only-BFF. Weder diese Oberfläche noch dieser Proxy erlauben echte
API-Keys oder aktivieren die Anbieter. Das produktive Backend ist weiterhin
nicht mit dem künftigen Schreib-Adapter verbunden.
