# P1-09 — Kostenmodell separat von VPS-Monitoring

**Aktueller Stand:** VPS-weite Ressourcen- und Containerüberwachung erfolgt
gemäß Betreiberentscheidung mit der bestehenden **Beszel-Installation**.
Siehe [Monitoring-Betriebsentscheidung](P1-09_BESZEL_MONITORING.md).
Die ehemals projektspezifischen Disk-, Telegram- und E-Mail-Tools wurden
als redundant zurückgenommen. Der ursprüngliche P1-09-Disk-Timer muss vor
dem Merge dieser Bereinigung auf dem VPS deaktiviert und entfernt werden.

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

**P1-09 bleibt offen:** Realer, autorisierter Verbrauch je Job, echte
Preise, Limits sowie unabhängig getestete Offsite-Sicherung/Restore fehlen.
