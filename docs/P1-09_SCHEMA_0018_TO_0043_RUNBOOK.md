# P1-09 – kontrolliertes Schema-Upgrade 0018 → 0043

Dieses Paket ergänzt den bisherigen produktiven Migrationsstand `0018`
um die verbleibenden PostgreSQL-Migrationen `0019–0043`. Das Upgrade ist
**noch nicht auf dem VideoNews-Studio-VPS ausgeführt oder freigegeben**.

Die bereits vom Betreiber bestätigten IONOS-Backups und das funktionierende
Beszel-Monitoring sind akzeptierte Voraussetzungen; sie werden nicht erneut
als offene Features behandelt. Vor einem _realen_ Datenbankeingriff bleibt
ein aktueller wiederherstellbarer Sicherungsstand organisatorisch wichtig.

## Umfang und Sicherheitsgrenzen

`scripts/p1_09_schema_0018_to_0043.py` kennt ausschließlich drei
Betriebsarten:

- `--status`: read-only Anzeige des vollständig bekannten aktuellen
  Ledger-Prefixes (auch bei einem teilweise fehlgeschlagenen Upgrade)
- `--preflight`: read-only Prüfung der Ausgangslage `0001–0018`
- `--apply`: 25 additive SQL-Migrationsdateien in exakt vorgegebener
  Reihenfolge aus dem sauberen lokalen `main`-Checkout

Das Skript akzeptiert kein beliebiges Datenbankziel, keine dynamischen
Migrationen und keinen Docker-Projektnamen außerhalb einer eigens
abgesicherten CI-Ausnahme. Es erfordert den gesunden Container
`videonews-studio-postgres-1`, PostgreSQL 17, Datenbank `videonews`,
den Superuser `vns`, einen exakten 18-zeiligen Ausgangs-Ledger und
eine vollständig zusammenhängende Menge von 43 Migrationsdateien.
Es verweigert aktivierte Provider, gespeicherte KI-Schlüssel,
vorzeitig vorhandene Live-Budget-/Dispatch-Tabellen und unerwartete
Worker-Rollen.

Vor jeder einzelnen Migration wird die exakte vorherige Ledger-Folge
abgeglichen. Nach jeder Migration muss der neue Ledger exakt stimmen.
Ein Abbruch führt **niemals** zu einer automatischen Wiederholung,
einem Drop oder zur Ausführung von `.down.sql` auf dem VPS. Bereits
committete Migrationen können bei einem Fehler bestehen bleiben.
Außerdem erzwingt das Skript freien Speicher und ausreichenden RAM.

Nach dem letzten Schritt prüft es den 43-zeiligen Ledger, vier
erwartete NOLOGIN-Funktionsrollen, weiterhin deaktivierte USD- und
EUR-Budgets, keine freigegebenen KI-Provider, keine gespeicherten
Provider-Schlüssel, keine Reservierungen, Claims oder Schlüsselreads
und keine provisionierten Worker-Logins.

Das Upgrade startet, stoppt oder ändert keine API-, Web-, Redis-,
Worker- oder Cloudflare-Tunnel-Container. Es verwendet keine Anbieter-SDKs,
API-Schlüssel oder bezahlten Requests.

## Für den späteren operatorgeführten Rollout

Die folgende Sequenz ist **keine Aufforderung zur sofortigen Ausführung**.
Erst bei Freigabe und wenn das VPS-Inventar wirklich zum Zustand
`0018` passt:

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p1_09_schema_0018_to_0043.py --status
python3 scripts/p1_09_schema_0018_to_0043.py --preflight
```

Für das tatsächliche Upgrade muss ein Betreiber den zuvor geprüften
40-stelligen `main`-Commit explizit pinnen und den Eingriff freigeben:

```bash
VNS_P109_0043_EXPECTED_MAIN_SHA=<GENAU_DER_GEPRÜFTE_40-STELLIGE_COMMIT> \
VNS_P109_0043_OPERATOR_APPROVED=APPLY_ADDITIVE_0019_0043 \
python3 scripts/p1_09_schema_0018_to_0043.py --apply
```

Bei Fehlern **keinen zweiten Apply-Versuch starten**. Nur
`--status` sowie eine unabhängige lesende Untersuchung verwenden,
dann die weitere Vorgehensweise ausdrücklich abstimmen.

Nach einem erfolgreichen Upgrade folgen unabhängig voneinander die
beiden Worker-LOGINs aus
`docs/P1-09_PROVIDER_WORKER_LOGIN_PROVISIONING.md`, die
nicht-aktivierte Worker-Laufzeitprüfung, die Verifikation echter
Anbieterpreise und die gesonderte Live-Kostenfreigabe.

## Reproduzierbare CI-Abnahme

Der Workflow `.github/workflows/p1-09-schema-0043.yml` erstellt
ausschließlich ein temporäres PostgreSQL-17-Compose-Projekt
`vns-p109-0043-ci`, seedet eine echte isolierte `0018`-Datenbank
und überprüft vor und nach dem genau gleichen Skript:

- read-only Status/Preflight, standardmäßig verweigerter Apply
- alle 25 neuen Migrationen bis einschließlich `0043`
- gesperrter zweiter Apply und gesperrtes wiederholtes Baseline-Preflight
- keine aktiven Anbieter, keine Preis-/FX-/Budgetfreigabe und keine
  Schlüssel oder KI-Ausgaben
- sichere Bereinigung des isolierten CI-Containers und Volumes

Separate Python-Unit-Tests prüfen beschädigte Ledgers, unerwartete
Schemas, Symlinks, fehlende Commit-Pins und den Abbruch ohne Retry.

**P1-09 ist auch mit diesem Schema-Upgrade-Helfer noch nicht
produktionsreif:** Es fehlen echte autorisierte Worker-Laufzeit,
unabhängige Provider-Preisprüfung, Live-Budget-Endabnahme und
der erst nach ausdrücklicher Freigabe erlaubte Kostentest bis
maximal 1 €.
