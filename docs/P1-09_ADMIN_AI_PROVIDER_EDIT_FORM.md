# P1-09 – Inaktive Admin-Eingabemaske für KI-Anbieter

**Stand: 25.10.2026 · nur Git/CI. Keine produktive Schlüsselannahme.**

Das Benutzeroberflächenziel bleibt: API-Keys für OpenAI und Gemini im geschützten
Admin-Bereich hinterlegen, austauschen und entfernen, englische Modelle
auswählen, ohne Schlüssel oder Modellnamen im Quellcode ändern zu müssen.
Die **tatsächliche** Konfiguration kann erst nach Betriebsgenehmigung
und erfolgreicher Integration umgesetzt werden.

## Implementiert

`apps/web/src/app/admin/ai-provider-edit-form.tsx` ist eine **unmontierte**
React-Komponente. Der aktuelle Admin-Bereich und sämtliche produktiven
Web-API-Routen importieren sie nicht.

- Standardmäßig `ready=false`: Es werden **keine** Formulare,
  Passwortfelder oder Mutationsbuttons gerendert.
- In isolierten Tests mit `ready=true`: ein verdecktes,
  unkontrolliertes API-Key-Feld, erlaubte Modellauswahl und eine
  separate, ausdrücklich zu bestätigende Löschaktion.
- Der API-Key wird nicht in React-State, HTML, URL oder LocalStorage
  abgelegt. Das Eingabefeld wird direkt nach dem Ablesen geleert.
  Es werden nur die fest vorgegebenen Befehle `set_key`,
  `remove_key` und `set_model` gebildet. Kein Aktivierungsbefehl,
  keine beliebigen Endpunkte und keine automatische Verbindungsprüfung.
- Die Komponente führt selbst **keinen** `fetch`-Aufruf aus.
  Sie hat ausschließlich einen injizierten `onCommand`-Callback;
  **in der laufenden Anwendung existiert keine solche Verbindung**.
- Eine erfolgreiche Meldung wird erst nach positiver Rückgabe
  des injizierten Callbacks gezeigt; Fehler werden generell
  formuliert. Keine Ausgaben enthalten Keys, Ciphertext oder
  Backend-Fehlerdetails. Der Anbieter bleibt deaktiviert.

**Wichtig:** JavaScript-Strings und Browser-Eingabefelder können
temporäre Kopien im Speicher halten; das Leeren des Feldes ist keine
garantierte vollständige Speicherlöschung. Spätere Produktion braucht
sicheren Transport, browserseitige CSP, serverseitiges No-Body-Logging,
Ratenbegrenzung, tatsächliche authentifizierte Admin-Rolle, CSRF-
und Same-Origin-Kontrollen, auditierte Datenbanktransaktion und
geschützten Master-Key-Mount.

## Tests und vorerst offenes Betriebsrisiko

`ai-provider-edit-form.test.tsx` prüft die default-off-Ausgabe,
maskierte Eingabe, erlaubte Modelle, explizit bestätigte Löschung,
verbotene Anbieter/Modelle/ungültige Schlüssel sowie das Fehlen
der Imports im aktiven Admin-Dashboard und im vorhandenen
GET-only-Proxy. Nur erfundene Platzhalter werden verwendet.

Das neue UI ist **noch nicht funktionsfähig** und darf bis zu
einem gesondert geprüften Key-Custody-/Rollen-/E2E-Rollout keine
realen Zugangsdaten entgegennehmen. Migrationen 0015/0016 und
produktive API-Registrierung bleiben unverändert deaktiviert.

Der Betreiber hat sich bewusst für den Weiterbetrieb **vorerst ohne
unabhängige Backups** entschieden. Es wurde kein Backup eingerichtet;
Daten- und Master-Key-Verlust wären ohne neue Sicherheitsmaßnahmen
nicht zuverlässig wiederherstellbar. Beszel bleibt unverändert.
