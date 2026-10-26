# P2-02 – Persistenter Feed-Claim und deduplizierte Kandidaten (CI-only)

**Entwicklungsstand:** Migration `0019_feed_poll_contract` ist **nicht auf dem VPS angewendet**. Alle Tests nutzen ausschließlich synthetische Inhalte in disposablen CI-Datenbanken. Keine zusätzlichen Live-Dienste, DNS-Abfragen, Secrets, Kosten oder Backups.

## Datenbankgrenze

Migration 0019 erstellt `vns.feed_poll_state` und `vns.feed_poll_candidates` mit ausschließlich redaktioneller Kandidaten-Metadatenhaltung (URL, Titel, optionales Datum). Kein Artikelvolltext, keine Assets, keine Claim-Verifikation oder automatische Lizenzfreigabe.

Zwei **NOLOGIN**-Rollen `vns_feed_poll_executor` und `vns_feed_poll_writer` kapseln alle Zugriffe. Der Writer hat ausschließlich `EXECUTE` auf zwei `SECURITY DEFINER`-Funktionen; kein direktes `SELECT`, `INSERT`, `UPDATE`, `DELETE` oder `CREATE`. Ein separater, künftig zu genehmigender LOGIN-Pool ist **nicht** erstellt.

- `vns.claim_feed_poll(source_id, interval_minutes)` reserviert den nächsten Abruf **atomar** per UPSERT auf `source_id`, mit PostgreSQL-`clock_timestamp()` statt untrusted Worker-Uhr. Ein verweigerter Claim liefert keine Zeile; nach Erfolg gilt das Mindestintervall selbst bei nachfolgendem Transportfehler. Die Funktion liefert einen zufälligen, versionierten UUID-Lease-Token plus ETag und Last-Modified.
- `vns.commit_feed_poll(source_id, lease_token, items, etag, last_modified)` sperrt den zugehörigen Datensatz transaktional und akzeptiert ausschließlich den **aktuell gültigen** Token. Fremde oder durch neuere Abrufe abgelöste Tokens können keine Metadaten überschreiben. Jeder Artikel wird mit Unique-Key `(source_id, article_url)` aufgenommen; wiederholte Meldungen behalten die ursprünglichen Metadaten. Validatoren und Kandidaten werden in **einer Transaktion** geändert, sodass Teilfehler zurückrollen.
- `apps/worker/src/postgres-feed-poll-store.ts` bildet diese Funktionen über parametrisierte SQL-Abfragen auf den bereits vorhandenen `FeedPollStore`-Vertrag ab. Es wird **kein** Pool geöffnet oder Handler gemountet; auch der Probe-Worker bleibt unverändert.
- Ein HTTP 304 veranlasst im bisherigen Poller keinen Kandidaten-Commit. Der Claim reserviert trotzdem das nächste Intervall, die bisherigen Validatoren bleiben gespeichert.

## CI-Nachweise

Die migrationsbasierte GitHub-Actions-Testsuite prüft 0019 **zweimal aufwärts und rückwärts**, Rollen- und Direktzugriffsverbote, idempotentes Insert, gesperrte/metadatenfremde Payloads, falsche/stale Token und erneuten Claim nach simuliertem Zeitablauf. Zwei unabhängige PostgreSQL-Sessions konkurrieren um eine identische Claim-ID; exakt eine darf den Slot erhalten.

Ergänzend prüfen reine Worker-Tests die parametrisierten SQL-Anfragen, geordnete Token-Übergabe, Payload-Reduktion, ungültige IDs und fehlende Ergebnisse. Keine Live-Webanfragen.

## Noch nicht produktiv abgenommen

- Tatsächlich vom Betreiber geprüfte drei bis fünf Quellen und gültige Nutzungsrechte; das Register darf keine unbestätigten Websites freigeben.
- Gesicherter HTTPS-/RSS-Transport mit gepinnten DNS-Adressen, TLS/SSRF-/Redirect-Schutz, Header-/Timeout-/Byte-Limits und echten ETag-/304-Checks.
- Separate Least-Privilege-`LOGIN`-Identität, Secret-Datei, Netzwerkzugriff, Restore-/Recoveryplan und kontrollierte DB-Migration; **keine** alleinige Aktivierung aus CI.
- Browser-/Queue-Scheduler-Rollout, Timeouts, Betriebs-Alarmierung, Monitoring, sichere Freigabe und echter End-to-End-Ingest.

**Sicherheitsgrenze:** Migration und Typverträge können ohne Live-Aktivierung gemergt werden. Es gibt keinen produktiven Scheduler, kein Key-Material und keinen Zugriff auf kostenpflichtige KI-Anbieter. Issues #16 und #17 bleiben für die vollständige Live-Abnahme offen.
