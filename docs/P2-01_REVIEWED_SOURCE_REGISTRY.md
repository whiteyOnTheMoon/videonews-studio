# P2-01 – Redaktionsseitiges Quellenregister (Offline-Vertrag)

**Status:** ausschließlich Git/CI. Das produktive VideoNews-Studio ruft noch keine RSS-Feeds ab. Die isolierte Research-Queue ist nicht aktiviert. Keine echten externen Requests oder Quellenfreigaben.

## Verpflichtende Prüfung pro Quelle

Die Datei `/run/secrets/reviewed_research_sources.json` enthält ein vom Betreiber geprüftes Register. Das Format `version:1` fordert pro Eintrag genau die folgenden Felder:

| Feld | Bedeutung |
|---|---|
| `id` | Eindeutiger redaktioneller Kennzeichner |
| `baseUrl` | Exakt geprüfter HTTPS-Hostname **und Pfadpräfix**, mit abschließendem `/` |
| `status` | `pending`, `approved` oder `blocked` – nur `approved` wird verwendet |
| `access` | `rss`, `atom`, `official_api` oder `html` |
| `intervalMinutes` | Dokumentierter Mindestabstand 15–10080 Minuten; spätere Polling-Implementierung in #17 |
| `termsUrl` | Öffentlich zugänglicher HTTPS-Verweis auf Bedingungen |
| `usage` | `metadata_only` oder `reviewed_excerpt`; keine Volltextlizenz impliziert |
| `licenseNotes` | Freitext mit Nutzungseinschränkungen und Attribution |
| `reviewedAt` | Datum der letzten **menschlichen** Quellenprüfung (`YYYY-MM-DD`) |

Beispiel **ohne tatsächliche Freigabe**:

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

Die separate bestehende Host-Allowlist `VNS_ALLOWED_SOURCE_HOSTS` bleibt **zusätzlich** erforderlich. Unbekannte Hosts, nichtkanonische/pfadmanipulierte URLs und nicht freigegebene Präfixe werden verworfen. Die **spezifischste** passende Regel gewinnt: Ein `blocked`-Unterpfad überschreibt eine allgemein `approved`-Quelle. Nicht genehmigte Kandidaten werden vor Fetch und Speicherung entfernt. Ein Thema ohne freigegebene Kandidaten schlägt geschlossen fehl. Schon der frühere Themenkatalog verlangt explizite Themenfreigaben.

Der bislang **nicht deployte** `research-service.ts` verlangt beim Start über `VNS_RESEARCH_REGISTRY_FILE` den exakten Pfad zu diesem Register; ohne Datei/Opt-in kann der Prozess keine DB-/Redis-Clients oder Netzabrufe starten. Der laufende Probe-Worker und die vorhandene BullMQ-Queue bleiben unverändert.

**Abgrenzung:** Dieses Register **führt keine periodischen Abfragen aus**, kontrolliert noch keine realen Abrufintervalle/ETags und entscheidet nicht automatisch über Lizenzrechte von Artikeln oder Medien. Ein solcher Scheduler und RSS-/Feed-Adapter sind gesonderter Umfang von #17 (P2-02). Die Registrierung allein verifiziert weder Claims noch erlaubt sie Volltext-/Asset-Reuse. Keine kostenpflichtigen Dienste, Produktionsmigrationen, API-Keys, VPS-/Docker-Änderungen oder Backups.
