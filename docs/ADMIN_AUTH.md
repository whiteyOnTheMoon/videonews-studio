# P1-06 – Opt-in Admin-API-Authentifizierung (Vorbereitung)

**Stand:** Nur GitHub-Entwicklungsbranch. Keine Änderung am laufenden VPS-Web/API-Preview; **keine öffentliche Freigabe**.

## Funktion und Grenzen

Die API enthält einen ausdrücklich opt-in aktivierbaren lokalen Admin-Zugriff. Im Default ohne `VNS_ADMIN_AUTH_ENABLED=true` existieren weiterhin nur die bisherigen Healthchecks; Authentifizierungs- und Admin-Routen liefern 404. Diese Einstellung wird in `compose.yaml` absichtlich **nicht** gesetzt; damit sind alle bisher veröffentlichten und laufenden Image-Versionen unverändert.

Bei expliziter Aktivierung nach einer späteren HTTPS-/Ingress- und Betreiberentscheidung sind vorbereitet:

| Route           | Methode | Verhalten                                                                                   |
| --------------- | ------- | ------------------------------------------------------------------------------------------- |
| `/auth/login`   | POST    | Passwort gegen serverseitigen scrypt-Hash prüfen; ausschließlich sichere Sitzung als Cookie |
| `/auth/logout`  | POST    | Sitzung ungültig machen und Cookie löschen                                                  |
| `/auth/session` | GET     | Nur `authenticated` und ggf. `role`, nie ein Zugriffstoken                                  |
| `/admin/me`     | GET     | Nur mit aktiver Admin-Sitzung: `role: admin`; sonst 401                                     |
| `/healthz`      | GET     | Für Docker-Healthchecks ohne Anmeldung erreichbar                                           |

Sicherheitsschranken: `Secure`, `HttpOnly`, `SameSite=Strict` und `__Host-`-Cookie ohne Domain; 15-Minuten-Lebensdauer; zufällige 256-Bit-Sessiontokens, von denen nur SHA256-Digests im Arbeitsspeicher gespeichert werden; **keine** Tokenwerte im JSON, in URLs oder Logs. Login und Logout verlangen einen **exakten HTTPS-Origin** gegen CSRF. Die Passwörter werden mit Node.js `scrypt` und `timingSafeEqual` anhand eines vorbereiteten Salt-/Hash-Werts überprüft. Fünf fehlgeschlagene Anmeldungen pro IP und fünf Minuten sperren weitere Versuche vorübergehend. Sitzungen und Rate-Limit-Zähler haben Kapazitätsgrenzen.

Konfiguration wird bei aktiviertem Auth-Modus streng validiert: Fehlt ein Hash oder eine HTTPS-Origin bzw. ist die Formatierung fehlerhaft, **startet der API-Prozess nicht**. Erwartete Variablen sind `VNS_ADMIN_AUTH_ENABLED=true`, `VNS_ADMIN_ORIGIN=https://studio.example.invalid` (genau die spätere, vorher ausdrücklich freizugebende Origin) und `VNS_ADMIN_PASSWORD_HASH` im Format `scrypt$<16-byte-hex-salt>$<64-byte-hex-hash>`. Das Beispiel `.env.example` enthält keine tatsächlichen Zugangsdaten; Passwörter, Login-Cookies und Hash-Konfigurationen dürfen nicht ins Repository oder in Chat/Screenshots gelangen.

**Wesentliche Einschränkungen:** Diese erste Sicherheitsstufe hat **genau eine Rolle `admin`**, keine normalen Benutzer. Sie ist **noch keine produktionsfähige Authentifizierungsplattform**: Sitzungen und Sperrzähler liegen nur im Prozessspeicher und verschwinden bei Neustarts; es gibt noch keine persistente Benutzer-/Sitzungstabelle, keine Account-Recovery, kein Zwei-Faktor-Login, keine Admin-Oberfläche und keinen Reverse-Proxy-/HTTPS-Test. Ein geschütztes Login-API allein schützt **nicht** die gegenwärtige Next.js-Weboberfläche vor öffentlichem Zugriff. Es existieren außerdem noch keine produktiven redaktionellen Schreib-Endpunkte, für die diese Autorisierung als vollständiges Gate behauptet werden dürfte.

**Voraussetzung für echtes Deployment:** P1-05-Datenhaltungs-/Backup-Entscheidung, fertig geprüfte serverseitige Auth-Integration für die Weboberfläche, TLS/Ingress-Zugangsregelung und eigenständige Betreiberfreigabe. Weder Caddy, Cloudflare, Datenbankprofil noch ein neues Docker-Image werden in diesem PR ausgelöst.

## Automatisierte Tests

Der vorhandene [P1-03 Monorepo-CI-Workflow](../.github/workflows/p1-03-monorepo.yml) führt auf Pull Requests mit Änderungen unter `apps/**` Build, Typecheck, Lint, Prettier und `npm test` aus. Die neuen API-Tests prüfen ausdrücklich: aus ohne Aktivierung, Konfigurationsfehler, unautorisierte Admin-Routen, richtige Origin, falsche Passwörter, sichere Cookie-Eigenschaften, CSRF-Schutz beim Logout, Logout-Invalidierung, Ablauf, Ratelimit und das Fehlen des Tokens in JSON-Antworten.

Keine kostenpflichtigen Dienste, keine neuen npm-Abhängigkeiten, keine Datenbanken oder VPS-Änderungen. Ein Merge benötigt grüne CI und unabhängig durchgeführten Review oder eine **erneut, nur für diesen PR ausdrücklich genehmigte einmalige Ausnahme**.
