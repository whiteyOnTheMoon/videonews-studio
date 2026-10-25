# P2-01 – Redaktionsseitiges Quellenregister (Offline-Vertrag)

**Status:** Ausschließlich Git/CI. Das produktive VideoNews Studio ruft
noch keine RSS-Feeds ab. Die isolierte Research-Queue ist nicht
aktiviert. Keine externen Requests und keine echten Quellenfreigaben.

## Prüfpflichten für jede Quelle

Die operatorgeprüfte Datei
`/run/secrets/reviewed_research_sources.json`
enthält `version: 1` und eine Liste `sources`.
Jeder Eintrag erfordert genau diese Felder:

- `id`: eindeutiger redaktioneller Kennzeichner
- `baseUrl`: kanonischer HTTPS-Hostname und Pfadpräfix, mit `/` am Ende
- `status`: `pending`, `approved` oder `blocked`; nur `approved` zählt
- `access`: `rss`, `atom`, `official_api` oder `html`
- `intervalMinutes`: 15–10080 Minuten; Polling erfolgt erst in #17
- `termsUrl`: öffentlicher HTTPS-Link zu den Nutzungsbedingungen
- `usage`: `metadata_only` oder `reviewed_excerpt`
- `licenseNotes`: Lizenz- und Attributionseinschränkungen
- `reviewedAt`: Datum der menschlichen Prüfung (`YYYY-MM-DD`)

Beispiel ohne tatsächliche Freigabe:

```json
{
  "version": 1,
  "sources": [
    {
      "id": "sample_agency",
      "baseUrl": "https://www.example.org/news/",
      "status": "pending",
      "access": "rss",
      "intervalMinutes": 60,
      "termsUrl": "https://www.example.org/terms/",
      "usage": "metadata_only",
      "licenseNotes": "Only headlines and metadata may be cited after human review.",
      "reviewedAt": "2026-10-26"
    }
  ]
}
```

Die getrennte Host-Allowlist `VNS_ALLOWED_SOURCE_HOSTS` bleibt zusätzlich
erforderlich. Unbekannte Hosts, manipulierte URL-Pfade und nicht
freigegebene Präfixe werden abgewiesen. Die spezifischste Regel gewinnt:
Ein `blocked`-Unterpfad überschreibt ein allgemeines `approved`.
Nicht zugelassene Kandidaten werden vor Fetch und Speicherung entfernt.
Ohne freigegebene Kandidaten schlägt der Forschungsauftrag geschlossen
fehl. Auch der bestehende Themenkatalog muss separat freigegeben sein.

Der nicht deployte `research-service.ts` verlangt zusätzlich
`VNS_RESEARCH_REGISTRY_FILE` mit dem festgelegten Secret-Pfad.
Ohne diese Freigabe kann der Worker nicht starten.
Probe-Worker und produktive Redis-Queue bleiben unverändert.

**Abgrenzung:** Dieses Register plant keine periodischen Abfragen,
erzwingt noch keine Zeitintervalle oder ETags und erteilt keine
pauschale Lizenzfreigabe. Der Scheduler und die Feed-Adapter folgen
in #17 (P2-02). Ein URL-Eintrag verifiziert keine Claims und erlaubt
keine Wiederverwendung kompletter Artikel oder Assets.
Keine Kosten, echten Schlüssel, VPS-/Docker-Eingriffe oder Backups.
