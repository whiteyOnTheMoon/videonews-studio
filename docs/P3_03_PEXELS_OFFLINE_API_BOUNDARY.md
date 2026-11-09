# P3-03 – Pexels-Adapter: Offline-Metadatenprüfung (Teilumsetzung)

**Stand: 8. November 2026.** Issue #28. Dieser Baustein ist eine
**synthetisch testbare Parser- und Schutzschicht**, keine aktivierte
Pexels-Anbindung. Die tatsächliche Medienaufnahme und damit die
vollständigen Abnahmekriterien von #28 sind noch offen.

## Offizielle Bedingungen und aktueller Zugang

Primärquellen, geprüft am 8. November 2026:

- API-Dokumentation: https://www.pexels.com/api/documentation/
- Lizenz: https://www.pexels.com/license/
- Nutzungsbedingungen: https://www.pexels.com/terms-of-service/
- Neue API-Schlüssel laut Pexels aktuell pausiert:
  https://help.pexels.com/hc/en-us/articles/900004904026-How-do-I-get-an-API-key
- Pexels-Kurzfassung zu API-Nutzungsregeln:
  https://help.pexels.com/hc/en-us/articles/900005880463-What-are-the-Terms-and-Conditions
- Pexels empfiehlt 24 Stunden Metadaten-Cache:
  https://help.pexels.com/hc/en-us/articles/900006470063-What-steps-can-I-take-to-avoid-hitting-the-rate-limit

Die API verlangt einen Schlüssel im Authorization-Header. Neue
Schlüsselausgaben sind laut aktueller Hilfe pausiert; ein bereits
vorhandener, berechtigter Schlüssel wurde hier **nicht** geprüft.
Deshalb: **kein Live-Aufruf** und keine Aktivierung eines Accounts.

Der Standardrahmen beträgt laut API-Dokumentation 200 Anfragen je
Stunde und 20.000 im Monat. Anbieter-Link und Mitwirkenden-Credits
sind für API-Integrationen vorgesehen. Unabhängig von der allgemeinen
kommerziellen Pexels-Lizenz können abgebildete Personen und Marken
zusätzliche Nutzungsrechte erforderlich machen. Verboten sind u. a.
Standalone-Weiterverteilung, Stock-Service-Nachbildung sowie
unautorisierte Datensammlung für ML/AI-Modelle.

## Implementierte, ausführbare Grenze

`readOfflinePexelsPage(input, type)` verarbeitet ausschließlich
**bereits bereitgestellte** Pexels-API-ähnliche JSON-Objekte:

- `photo`: ID, öffentliche Fotoseite, Name und Profil des Fotografen
  sowie eine formal gültige Pexels-CDN-Originalreferenz.
- `video`: ID, öffentliche Videoseite, Name und Profil des
  Videografen sowie eine formal gültige Pexels-CDN-Vorschaureferenz.
- Strenge Quellen- und Host-Überprüfung, HTTPS ohne Zugangsdaten,
  ID-Abgleich und atomare Ablehnung bei fehlerhaften oder doppelten
  Medienobjekten.
- Eingabeseiten mit höchstens 80 Objekten, nicht mehr als `per_page`.
- Normalisierung auf Quellen-/Urheber-/Credit-Metadaten.
- 24-Stunden-Cache **nur als dokumentierter Hinweis**, keine
  ausgeführte Speicherung oder echte Cache-Implementierung.

Die Ausgabe exportiert keine CDN-/Video-Downloads, keine API-Schlüssel,
keine Authorization-Header, keine Lizenz-Snapshots und keine erfundenen
Inhalts-Hashes. Eine erfolgreich normalisierte Pexels-Quelle erhält
immer `rightsStatus = blocked`, `contentSha256 = null`,
`licenseSnapshot = null`, unbekannte Drittanbieterrechte und
`renderAllowed = uploadAllowed = false`.

**Besonders wichtig:** Die Pexels-Lizenz ist eine eigene
Anbieterlizenz, nicht CC0/CC BY. P3-02 kann sie deshalb nicht als
erlaubte Creative-Commons-Lizenz klassifizieren. Selbst vollständige
API-Metadaten sind *keine* rechtssichere Freigabe des konkreten Assets.

## Grenzen bis zur P3-Funktionsabnahme

Noch nicht implementiert und **nicht autorisiert**:

1. Ein zulässiger Pexels-API-Zugang samt Quoten-/Fehlerbehandlung.
2. Cache mit geeigneter Datensparsamkeit und Lösch-/Ablaufregeln.
3. Download mit Host-/Weiterleitungsprüfung, Content-Type,
   Dateigrößenbegrenzung und SHA-256 aus tatsächlich empfangenen Bytes.
4. Unveränderlicher Lizenz-Snapshot zum Zeitpunkt des Downloads,
   belegte Urheberrechte und Prüfung von Person-/Markenfreigaben.
5. Anbindung an `vns.assets`, redaktionelle Prüfung und echte
   Render-/Upload-Entry-Point-Sperre; keine Veröffentlichung.

Die vorhandenen Tests arbeiten ausschließlich mit synthetischen
JSON-Fixtures; sie rufen keine fremden Medien oder APIs ab und
legen keine Pexels-Bilder in ein Dataset.

**#28 offen lassen.** PR und CI liefern einen überprüfbaren
Eingangsvertrag, aber noch keine aktive oder kommerziell freigegebene
Pexels-Medienquelle. Weder VPS noch Datenbanken werden verändert.
