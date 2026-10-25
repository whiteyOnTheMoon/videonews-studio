# P1-09 – Gemeinsame Datenbank-Sperre für KI-Anbieteränderungen

**Stand:** 25.10.2026. Nur Git/CI; keine Freischaltung auf dem VPS.

## Implementiert

- Migration 0017 erstellt eine einzelne persistente Zeile für das globale Rate-Limit.
- Die Funktion `vns.admin_try_ai_provider_mutation_slot()` erlaubt höchstens fünf Versuche in 60 Sekunden.
- Die Transaktion verwendet eine PostgreSQL-Zeilensperre und die Datenbankuhr.
- Bei rückwärts laufender Uhr oder fehlendem Zähler wird keine Kapazität gewährt.
- Nur der NOLOGIN-Provider-Writer erhält EXECUTE auf die SECURITY-DEFINER-Funktion.
- Bestehende API- und Research-Rollen erhalten keine neuen Rechte.
- Der Writer kann den Zähler nicht direkt lesen, überschreiben oder löschen.
- Ein neuer, weiterhin inaktiver TypeScript-Adapter nutzt ausschließlich diese Funktion.
- Der optionale Admin-Handler akzeptiert jetzt auch asynchrone Rate-Limiter.
- Verweigerte Versuche liefern HTTP 429, Datenbankausfälle einen generischen HTTP 503.
- Fehler werden vor dem Lesen des Credential-Bodys und vor SQL-Konfigurationsänderungen abgewehrt.

## CI-Nachweise

- Migration und Rollback laufen zweimal in einem isolierten PostgreSQL-17-Container.
- Zwei SQL-Sitzungen konkurrieren um acht Versuche: genau fünf Zusagen und drei Ablehnungen.
- Die persistierte Zählerzeile enthält anschließend genau fünf verbrauchte Versuche.
- Die SQL-Tests prüfen Rollenrechte, Rücksprung der Uhr und fehlende Zählerzeilen.
- TypeScript-Tests prüfen DB-Fehler, ungültige Antworten und geheime HTTP-Daten.
- Ein separater Full-Schema- und Rollen-Restore prüft Daten und Berechtigungen.

## Keine produktive Freigabe

- Die Zuordnung zu einer einzelnen Admin-Person und die MFA-Freigabe fehlen weiterhin.
- Der Zähler ist global, nicht personenbezogen.
- Eine eigene, streng berechtigte produktive Datenbankanmeldung existiert noch nicht.
- `apps/api/src/index.ts` registriert weiterhin keinen Provider-Konfigurationshandler.
- Web-BFF-POST, echte API-Keys, KI-Nutzung und kostenpflichtige Aufrufe bleiben deaktiviert.
- Keine VPS-Migration, kein Docker- oder Beszel-Eingriff und keine neue Backup-Einrichtung.
- Das unabhängige Offsite-Backup bleibt entsprechend der Betreiberentscheidung vertagt.
