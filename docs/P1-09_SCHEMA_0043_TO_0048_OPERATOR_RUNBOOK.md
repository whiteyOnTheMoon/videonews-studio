# P1-09 — freigabepflichtiges PostgreSQL-Upgrade 0043 → 0048

**Status:** Vorbereiteter Operator-Vertrag. Keine produktive Ausführung durch
diesen PR. Bereits vom Betreiber bestätigte IONOS-Backups und Beszel bleiben
abgenommen; es wird kein neues Backup-System eingeführt.

## Bestätigter Ausgangsstand am 28. Oktober 2026

- Datenbank: PostgreSQL 17 `videonews`, exakt 43 Migrationen; letztes Ledger
  `0043_claimed_provider_secret_scope`.
- Outbox-NOLOGIN-Rollen und das eigene Producer-LOGIN fehlen.
- Produktiver Git-Checkout ist älter als GitHub `main`. Die reine
  Git-Aktualisierung muss vor dem Preflight als eigener, geprüfter
  Fast-Forward erfolgen.
- Laufende Container werden durch den Migrationshelfer nicht verändert.
- Die neue `./secrets/vns-outbox`-Secret-Custody wird separat vorbereitet.

## Sicherheitsmechanismus

`scripts/p1_09_schema_0043_to_0048.py` kennt nur:

- `--status`: read-only Prüfung des exakt passenden Ledgers zwischen 0043
  und 0048, auch nach einem unklaren Abbruch.
- `--preflight`: read-only Prüfung des unveränderten exakten 0043-Ledgers,
  gesunden erwarteten PostgreSQL-Containers, PostgreSQL 17 und Superuser
  `vns`, ausgeschalteter Provider-/Budget-/EUR-Freigaben, fehlenden
  0044–0048-Objekten/Rollen, ausreichender Laufwerks-/RAM-Ressourcen und
  fünf unveränderten additiven Migrationsdateien.
- `--apply`: nur nach eigener **ausdrücklicher Betreiberfreigabe**, mit
  überprüftem `main`-SHA in
  `VNS_P109_0048_EXPECTED_MAIN_SHA` und exakter Freigabevariable
  `VNS_P109_0048_OPERATOR_APPROVED=APPLY_ADDITIVE_0044_0048`.
  Jede Migration läuft einzeln mit dem vorhandenen SQL-eigenen
  `BEGIN/COMMIT`; vor/nach jedem Schritt wird das gesamte Ledger
  verglichen. Beim ersten Fehler sofortiger Abbruch, **niemals** automatische
  Wiederholung oder produktive `.down.sql`-Migration.

Vor dem Upgrade müssen alle laufenden API-/Web-/Worker-Images ihre
Provider-/Outbox-Neuerungen **noch deaktiviert** halten. Das Upgrade
ändert keine Secrets, Redis ACL, Compose, API, Web oder laufende Worker.
Es löst keinen KI-Anbieteraufruf aus und schaltet keine Kostenfreigabe ein.

## Späterer Betreiberablauf (nicht vorab autorisiert)

Zuerst ein eigener sicherheitsgeprüfter Git-Fast-Forward auf den konkret
benannten Release-Commit (keine Docker-Aktion). Danach:

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p1_09_schema_0043_to_0048.py --status
python3 scripts/p1_09_schema_0043_to_0048.py --preflight
```

Die produktive Schreibaktion bleibt bis zu einer neuen **konkreten**
Betreiberfreigabe ausgesetzt. Erst danach den Operator-genehmigten,
SHA-gepinnten `--apply` ausführen, anschließend read-only `--status`,
Ledger/ACL/Provider-/Budget-Flags vergleichen und unabhängig abnehmen.

Ein Ausführungsfehler kann bereits einzelne abgeschlossene Migrationen
hinterlassen. Dann **nur** lesend untersuchen, nicht blind fortsetzen,
keine Transaktion rückgängig machen und keine Container starten.

Nach erfolgreichem 0048 folgen separat und ebenfalls genehmigungspflichtig:
Producer-Secret-Custody, SCRAM-LOGIN, nachweislich isolierte aktive Redis
ACL, geteilte aber separat verwahrte Prompt-Verschlüsselung, freigegebener
digest-gepinnter Container sowie ein einzelner nachweislich nicht-bezahlter
Produktionsdurchlauf. Ein echter kostenpflichtiger Anbieter-Kanarientest
bleibt bis zur separaten ausdrücklichen Freigabe gesperrt.

## CI

Der spezifische Workflow `.github/workflows/p1-09-schema-0048-upgrade.yml`
testet genau diesen Operator-Helfer auf einem temporären PostgreSQL 17.
Er prüft die vollständige Migration 0001–0043 als Ausgangsbasis, das
Verweigern von `--apply` ohne Genehmigung, 0044–0048, das Abweisen eines
zweiten Apply-Versuchs und dauerhaft deaktivierte Provider-/Budget-Flags.
Alle Container/Volumes im CI-Projekt sind wegwerfbar. Der erfolgreiche
CI-Lauf ist **kein** Nachweis der produktiven VPS-Ausführung.
