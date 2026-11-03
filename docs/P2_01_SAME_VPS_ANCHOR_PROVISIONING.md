# P2-01 – Ein-VPS-Anker: kontrollierte Einrichtung

Diese Anleitung gilt ausschließlich für den bestehenden VideoNews-Studio-VPS mit PostgreSQL 17.

**Risikoentscheidung:** Der lokale Anker teilt Administrator-, Backup- und Restore-Bereich mit der
Anwendungsdatenbank. Ein vollständiger VPS-Rollback wird dadurch nicht unabhängig verhindert.

## Operatorbefehle

Das Skript `scripts/p2_01_same_vps_anchor.py` trennt fünf Aktionen:

- `--preflight`: Lesende Prüfung von Release, Datenbank, Quellen, Hosts und Audits.
- `--install`: Einmalige Ankerinstallation nach expliziter Freigabe und SHA-Prüfung.
- `--verify`: Lesende Prüfung von High-Water-Daten, Eigentümern und SQL-Rechten.
- `--handoff`: Gesonderte root-autorisierte Übergabe des vorhandenen Passworts.
- `--verify-handoff`: Lesender Vergleich der geschützten Laufzeitdatei.

Vor jedem Aufruf müssen `main`, exakter Release-SHA und ein sauberes Arbeitsverzeichnis stimmen.

Die zwei SHA-256-Werte müssen aus dem aktuell geprüften signierten Export stammen.
Quellen- und Hostrevisionen müssen mit den persönlich auditierten Freigaben übereinstimmen.

## 1. Read-only Preflight

```bash
cd /home/ap/www/videonews-studio

python3 scripts/p2_01_same_vps_anchor.py --preflight \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --source-revision 8 --host-revision 7 \
  --envelope-sha256 41206305bbdee718adf011f8faa91485e8f9bfaadbd3d9d4a776016fc9f9e6e9 \
  --policy-revision 1 \
  --policy-sha256 bc2e875d1e01d3d311587f54b1a9559a91f0b42e17a4102073babfb0912683ed
```

Die obenstehenden Revisionen und Digests sind **historische Prüfwerte**, keine automatischen Defaults.

## 2. Einmalige Installation – nur nach persönlicher Freigabe

```bash
cd /home/ap/www/videonews-studio

VNS_P2_SAME_VPS_ANCHOR_OPERATOR_APPROVED=INSTALL_ONE_LOCAL_SOURCE_ANCHOR_ONLY \
VNS_P2_SAME_VPS_ANCHOR_EXPECTED_SHA=FREIGEGEBENER_MAIN_SHA \
python3 scripts/p2_01_same_vps_anchor.py --install \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --source-revision 8 --host-revision 7 \
  --envelope-sha256 41206305bbdee718adf011f8faa91485e8f9bfaadbd3d9d4a776016fc9f9e6e9 \
  --policy-revision 1 \
  --policy-sha256 bc2e875d1e01d3d311587f54b1a9559a91f0b42e17a4102073babfb0912683ed
```

Die Installation verwendet eine SQL-Transaktion und überträgt nur einen SCRAM-Verifier.
Passwortdateien sind privat; kein Secret wird nach GitHub oder Chat übertragen.

Bei einem Fehler nach Installationsbeginn **nicht erneut installieren**.
Vorhandene Daten, Passwortdatei und SQL-Rollen zunächst lesend abgleichen.

## 3. Separater Nachweis und Passwortübergabe

`--verify` benötigt dieselben überprüften Revisions- und Digest-Argumente wie `--preflight`.

Nach dem erfolgreichen `--verify` darf der Betreiber die vorhandene Passwortdatei übergeben:

```bash
sudo python3 scripts/p2_01_same_vps_anchor.py --handoff \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --approval HANDOFF_ONE_EXISTING_ANCHOR_PASSWORD_ONLY

sudo python3 scripts/p2_01_same_vps_anchor.py --verify-handoff \
  --expected-sha FREIGEGEBENER_MAIN_SHA
```

Der für Compose bereitzustellende Hostpfad ist:

```text
/var/lib/videonews-studio/p2-anchor-runtime-secret/vns_feed_source_anchor_password
```

Nur der Observer, Scheduler oder Consumer darf dieses Secret erhalten, niemals der Producer.

## Produktionsfreigabe ist separat

Ein bestandener Ankercheck startet keine Feed-Queue, kein HTTP, kein KI-Modell und keine Veröffentlichung.

Erst nach Rechtenachweis, geprüftem Quellensnapshot und gesondertem Betreiber-ACK
darf ein einzelner `single_pass`-Observer die erste Checkpoint-Datei selbst erzeugen.

Nach jeder VPS-Wiederherstellung Feed-Dienste deaktiviert lassen, bis signierter Export,
SQL-High-Water, Freigaben und Checkpoint erneut abgeglichen wurden.

Die bestehenden IONOS-Backups und Beszel-Monitoringmaßnahmen bleiben unverändert.
