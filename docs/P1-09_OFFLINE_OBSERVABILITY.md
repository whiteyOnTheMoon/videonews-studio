# P1-09 — Kostenmodell separat von VPS-Monitoring

**Aktueller Stand:** VPS-weite Ressourcen- und Containerüberwachung erfolgt
gemäß Betreiberentscheidung mit der bestehenden **Beszel-Installation**.
Siehe [Monitoring-Betriebsentscheidung](P1-09_BESZEL_MONITORING.md).
Die ehemals projektspezifischen Disk-, Telegram- und E-Mail-Tools wurden
als redundant entfernt. Der ursprüngliche P1-09-Disk-Timer ist auf dem VPS
bereits deaktiviert und deinstalliert (Betreiberprotokoll vom 25.10.2026).

## Offline-Kostenmodell bleibt erhalten

Das PostgreSQL-Schema besitzt bereits die Tabelle `vns.costs`.
Die laufende Probe-Worker-Konfiguration führt jedoch keine Anbieteraufrufe
durch. Es sind daher **keine tatsächlichen Token-/Gebührenwerte** verfügbar.

`scripts/p1_09_cost_model.py` akzeptiert ausschließlich `jobId`,
`requestId`, `provider`, `model`, `inputTokens`, `outputTokens`,
`inputMicroUsdPerMillion`, `outputMicroUsdPerMillion`.
Die Mengen und Preisraten müssen durch später genehmigte Integrationen
explizit geliefert werden; das Skript errät oder lädt keine Preise.
Es berechnet deterministische, auf Mikro-USD aufgerundete **Schätzungen**.

Identische `(jobId, requestId)`-Einträge werden bei einer Zusammenfassung
nur einmal gezählt; widersprüchliche Wiederholungen werden abgewiesen.
Es akzeptiert keine Prompts, Zugangsdaten oder beliebige Freitextfelder.

### Rein synthetisches Beispiel

```sh
printf '%s\n' '{"jobId":"b274db39-cfd5-46bf-8438-27557b89201a","requestId":"ci_request_000001","provider":"fixture","model":"ci-model-v1","inputTokens":1000,"outputTokens":500,"inputMicroUsdPerMillion":2000000,"outputMicroUsdPerMillion":8000000}' | python3 scripts/p1_09_cost_model.py --calculate
```

`--summarize` erwartet maximal 100 Ereignisse als JSON-Array.
Alle Ausgaben enthalten `"estimated":true` und sind **keine Rechnungen**.

### Verbleibende CI

Das bestehende ressourcenschonende GitHub-Actions-Workflow-Skelett
`p1-09-offline-observability.yml` führt nur noch die Unit-Tests des
Kostenmodells aus. Kein Docker, SMTP, Redis, PostgreSQL, Beszel-Zugriff
oder kostenpflichtiger Drittanbieter wird aufgerufen.

## Synthetische Datenbank- und Worker-Anbindung

Eine getrennte, **nicht aktivierte** Erweiterung ist unter
[P1-09 Token Usage Ledger](P1-09_TOKEN_USAGE_LEDGER.md) dokumentiert.
Sie enthält PostgreSQL-Migration 0013 für append-only synthetische
Job-/Request-Belege, idempotente SQL-Funktion und einen Test-gesteuerten
Worker-Adapter. Die neue Tabelle weist Einträge ausdrücklich nur als
`synthetic` aus und gewährt laufenden App-Rollen keine neuen Rechte.
Migration 0013 wurde **nicht** auf dem VPS ausgeführt.

## Architekturentscheidung für englischsprachige Erklärvideos

OpenAI wird als zuerst vorzubereitender Textanbieter gewählt:
`gpt-6-luna` für günstige Klassifizierung und `gpt-6.1-sol`
für Skripte sowie Quellen-/Claim-Audit. Google Gemini TTS ist
der erste Kandidat für die spätere englische Sprecherstimme.

Der [inaktive Anbieter-/Budgetplan](P1-09_ENGLISH_AI_PROVIDER_POLICY.md)
ist mit synthetischen Rechenfällen getestet. Er sendet nichts, hat
keine Zugangsdaten und erteilt ausdrücklich keine Kostengenehmigung.

## Simulierte OpenAI-Antworten ohne API-Nutzung

Das zusätzliche [OpenAI-Mock-Protokoll](P1-09_MOCK_OPENAI_RESPONSES.md)
prüft abgeschlossene, synthetische Textantworten für die drei englischen
Redaktionsstufen samt Token-Zählung und geschätztem Kostenbeleg.
Es führt weder HTTP-Anfragen aus noch greift es auf echte Inhalte,
Zugangsdaten oder Datenbanken zu. Es bleibt vom produktiven Worker getrennt.

## Synthetische Budgetreservierung mit Transaktionssperren

Die [dauerhafte synthetische Budgetvormerkung](P1-09_SYNTHETIC_BUDGET_RESERVATIONS.md)
wird durch die **nur für CI gedachte** Migration 0014 ergänzt. Sie prüft
die vorgeschlagenen Request-, Job- und Tagesgrenzen transaktional und
verhindert doppelte Vormerkungen. Separate parallele Datenbanksitzungen
werden im isolierten PostgreSQL-17-Test gegeneinander geprüft.
**Auf dem VPS weder installiert noch aktiviert; keine API-Kostenfreigabe.**

## Zukünftige Administration der KI-Zugangsdaten

Die [Sicherheitsvorbereitung für die Admin-Konfiguration](P1-09_ADMIN_PROVIDER_CREDENTIALS.md)
führt eine deaktivierte Anbietereinstellung und ein separates Modell für
verschlüsselte API-Keys ein. Die Verschlüsselung mit AES-256-GCM wird durch
lokale Fixtures getestet, aber es gibt noch keine Oberfläche zur Eingabe
echter Schlüssel, keinen produktiven Speicher und keine neuen Runtime-Rechte.
Schlüssel gehören weder ins Git-Repository noch in Chatnachrichten.

**P1-09 bleibt offen:** Reale autorisierte KI-Anfragen, tatsächliche
Verbrauchs-/Preis-/TTS-Erfassung, atomare Budgetreservierung und
unabhängig getestete Offsite-Sicherung/Restore fehlen.
