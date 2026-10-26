# P2-01 – Geplante Admin-Verwaltung für Nachrichtenquellen

**Git/CI-only. Nicht produktiv aktiviert.** Dies ist eine
vorbereitete Admin-Konfiguration für das bereits existierende
P2-01-Quellenregister und den P2-02-Feed-Scheduler. Es wird
**kein** Newsletter, Nachrichtenanbieter, API-Key, Modell oder
Feed-Host im Quellcode für die Produktion vorgegeben.

## Bedienung und sichere Freigabeschritte

Die unmontierte Komponente
`apps/web/src/app/admin/news-source-editor.tsx` wird künftig
aus dem persönlichen Admin-Bereich bedient. Sie zeigt vom Server
geladene Quellen und stellt ausschließlich injizierte
`onCommand`-Aktionen bereit, **keinen** eigenen `fetch`,
keine fest verdrahtete URL und keine Secret-Eingaben.

- Quelle **anlegen**: ID, HTTPS-Basis-/Feed-URL, RSS/Atom/API/HTML,
  Mindestabstand, HTTPS-Nutzungsbedingungen, Nutzungsmodus und
  Lizenz-/Attributionshinweise. Anfangsstatus immer `pending`.
- Quelle **bearbeiten**: selbst vorher genehmigte Quellen werden
  automatisch wieder `pending`, um alte Rechte-Entscheidungen
  nicht auf eine geänderte Quelle zu übertragen.
- Quelle ausdrücklich **freigeben**: separat bestätigte Aktion
  `approve` nur aus `pending`; die API akzeptiert niemals
  den Status `approved` oder ein Review-Datum direkt aus dem
  Browserformular.
- Quelle **sperren** (`blocked`) und zur erneuten Prüfung
  auf `pending` zurücksetzen (`reopen`). Es gibt bewusst
  kein ungeprüftes Sofortlöschen des Audit-Verlaufs.

Der unmontierte API-Vertrag
`apps/api/src/admin-source-registry.ts` fordert **jede**
Änderung durch eine serverseitig geprüfte persönliche
`EditorAuth.authenticatedAdminIdentity` mit Rolle `admin`,
exakte Origin-Prüfung, injizierten Pflicht-Rate-Limiter,
striktes JSON mit maximal 4096 Bytes und einen
`expectedRevision`-Abgleich. Nur der Server setzt das
Review-Datum und die Actor-ID.

## Persistenz und Audit – harte Grenze

`SourceAdminStore.saveWithAudit` ist aktuell **nur eine
Schnittstelle**. Die spätere Implementierung **muss**
revisionsbedingten Vergleich, Quellenänderung und benanntes,
unveränderliches Audit **in einer einzigen PostgreSQL-
Transaktion** umsetzen. Kein aktueller produktiver Login,
kein SQL-Migrationsskript und kein BFF-POST ist hierfür
registriert. Die bisherigen Tests verwenden ausschließlich
einen synthetischen In-Memory-Store.

Das bislang bestehende Registry-Dateiformat
`reviewed_research_sources.json` ist weiterhin die
streng überprüfte Offline-Grundlage des Feed-Workers.
**Die neue Admin-Oberfläche und die Registry-Datei sind
noch nicht live synchronisiert.** Vor einem Umstieg müssen
eine read-only geprüfte Export-/Snapshot-Schnittstelle,
dieselbe Host- und URL-Policy sowie atomare Versionswechsel
mit Runtime-Rollback getestet werden.

Die getrennte Host-Allowlist `VNS_ALLOWED_SOURCE_HOSTS`
bleibt bis zu dieser geprüften Übergabe ein zusätzliches,
explizites Betriebsgate. Das ist **keine** fest codierte
Anbieterliste, aber heute noch eine manuelle
Umgebungskonfiguration; später soll auch sie über die
sichere Admin-Konfiguration verwaltet werden.

## Nicht erledigt / vor Aktivierung erforderlich

- Produktive PostgreSQL-Tabellen, minimal berechtigter
  Writer-LOGIN, transaktionaler Source-Audit, echte
  Browser-BFF-/API-Session-End-to-End-Tests.
- Admin-Oberfläche und BFF-Route tatsächlich montieren,
  Rollen-/CSRF-/Replay-Tests, Approval-Workflow
  mit expliziter Betreiberabnahme.
- Sichere Übernahme in Worker-Register/Host-Policy,
  explizite Laufzeitfreigabe, kontrollierte Migration,
  Backup-/Restore-Konzept (#228) und Alarmierung (#229).
- Bei Anbietern mit Zugangsdaten: **gesonderter**
  verschlüsselter Key-Vault/Secret-Lifecycle nach #227;
  **niemals** API-Schlüssel in Source-Metadaten, JSON,
  GitHub oder die Admin-Browserantwort aufnehmen.
  Derzeit bestehen im alten **dormanten** KI-Provider-Vertrag
  noch erlaubte Modell-/Provider-Whitelists; deren spätere
  Konfiguration im Admin-Tool ist eine separate Arbeit,
  nicht durch dieses Quellen-Issue erledigt.

**Keine VPS-/Docker-Änderungen, keine echten Feeds,
keine kostenpflichtigen KI-Aufrufe und keine produktive
Freischaltung.** Issues #16 und #17 bleiben für
endgültige Browser-/DB-/Live-Abnahme offen.
