# P2-02 – Eigene, nur lesbare Laufzeit-Secrets für die Feed-Dienste

**Status:** GitHub-Implementierung; bis zur separaten Ausführung auf dem VPS
sind keine Laufzeitdateien erstellt und keine Container gestartet.

## Bestätigte VPS-Ausgangslage

Am 31.10.2026 meldete die schreibgeschützte Inventur unter Release
`08f5f162ed5d06188329e72ae5539b2a95611e34`:

- Zwei Redis-Passwortdateien und drei PostgreSQL-Passwortdateien: Eigentümer
  UID 1000, private Elternverzeichnisse 0700 und reguläre Dateien 0600.
- Noninteractive sudo: nicht verfügbar. Eine interaktive sudo-Freigabe
  beziehungsweise authentifizierter Administratorzugang ist erforderlich;
  ein Docker-root-Helfer ist ausdrücklich **nicht** vorgesehen.
- Keine sechs zukünftigen Feed-Produktionsdienste laufen.
- PostgreSQL-Dienstkonten sind produktiv geprüft, neue Redis-ACL ist aktiv,
  alle vier Redis-Authentifizierungen sind auf dem echten VPS bestanden.
- Bestehende Backups (IONOS) und Monitoring (Beszel) sind vom Betreiber bestätigt.

## Exakte Containerzuordnung

Der Helper `scripts/p2_02_feed_runtime_handoff.py` liest fünf **bereits
vorhandene** Passwörter und erzeugt identische, unabhängige Kopien unter
`/var/lib/videonews-studio/p2-feed-runtime-secrets/`:

- `vns_source_export_db_password`: 10001:10001, source-publisher.
- `vns_feed_db_password`: 10002:10002, feed-consumer.
- `vns_feed_producer_redis_password`: 10002:10002, feed-producer.
- `vns_feed_consumer_redis_password`: 10002:10002, feed-consumer.
- `vns_feed_project_db_password`: 10004:10004, feed-project-once und
  feed-project-continuous.


Die Zielverzeichnisse gehören **root:root (0700)**. Jede der fünf Dateien
erhält den eigenen numerischen Dienst-UID/GID und den Modus **0400**. Ein
Container bekommt später nur die exakt erforderlichen Dateien per readonly
Bind-Mount. Beide Feed-Rollen verwenden aus Gründen des bestehenden
Compose-Vertrags UID 10002; die Geheimnistrennung setzt deshalb auch
konsequente, voneinander getrennte Mounts voraus, nicht nur POSIX-Rechte.

## Betreiberphasen

1. Den durch CI geprüften und explizit freigegebenen `main`-SHA auf dem
   Server installieren. Alten Stand und sauberes Arbeitsverzeichnis prüfen.
2. Als `ap` ohne sudo:
   `python3 scripts/p2_02_feed_runtime_handoff.py --preflight --expected-sha SHA`.
   Dieser Schritt liest und validiert fünf bestehende lokale Passwörter,
   prüft die Abwesenheit von Feed-Containern und bestätigt GitHub-main.
   Er schreibt **nichts**. Er bestätigt absichtlich noch nicht die
   mögliche Existenz eines root-privaten Zielverzeichnisses.
3. Einmalig unter lokal authentifiziertem root via **interaktivem**
   `sudo python3 scripts/p2_02_feed_runtime_handoff.py --install --expected-sha SHA --approval INSTALL_FIVE_RESTRICTED_FEED_SECRET_COPIES_ONLY`.
   Die Freigabe ist nur für die fünf restriktiven Dateikopien.
   Das Skript überprüft erst lokal Release, vorhandene Secrets,
   fehlende Feed-Container und das root-sichere `/var/lib`.
   Dann wird das noch fehlende root-private Verzeichnis angelegt und
   jede Datei mit `O_EXCL|O_NOFOLLOW`, `fchown`, `fchmod` und `fsync`
   geschrieben. Ursprüngliche Passwörter bleiben **unverändert**.
4. Root führt `--verify --expected-sha SHA` aus: Prüft exakt fünf
   unveränderte Kopien, die Eigentümer, Rechte und Quelldateien. Keine
   Passwörter, Passwort-Hashes, API-Aufrufe oder Source-Daten ausgeben.

Bei jeder unerwarteten Meldung **nicht erneut installieren**; Teilergebnisse
bleiben absichtlich erhalten, damit die Ursache ohne geheime Ausgaben
diagnostiziert werden kann. Es werden nie automatisch Verzeichnisse gelöscht,
Berechtigungen an alten Dateien geändert oder Secrets rotiert.

Die Produktion bleibt deaktiviert: Dieser Helper startet weder Docker noch
Redis, PostgreSQL, Queue, KI-Anbieter oder Feed. Signierschlüssel, geprüfte
Quellen, unabhängiger TLS-Revisionsanker und ein echter Produktions-Canary
werden getrennt freigegeben.

## Nur spätere Container-Konfiguration

Die folgenden Hostvariablen sind **Pfade**, keine Passwörter:

- `VNS_P2_SIGNER_DB_PASSWORD_FILE` zeigt auf die neue Publisher-Datei.
- `VNS_P2_FEED_PRODUCER_REDIS_PASSWORD_FILE` zeigt auf die Producer-Datei.
- `VNS_P2_FEED_DB_PASSWORD_FILE` zeigt auf die Consumer-Datenbankdatei.
- `VNS_P2_FEED_REDIS_PASSWORD_FILE` zeigt auf die Consumer-Redis-Datei.
- `VNS_P2_PROJECTOR_DB_PASSWORD_FILE` zeigt auf die Projektor-Datei.

Beim tatsächlichen Compose-Aufruf sind Profile und Freigaben zunächst
deaktiviert. Jeder zukünftige Container braucht eine eigenständige
Mount-/Identitäts- und DB-/Redis-Abnahme. Der Producer darf insbesondere
niemals die Consumer-PostgreSQL- oder Anker-Secrets mounten.

**Sicherheitsgrenze aus P1:** Das alte Redis-Konto `vns_worker` besitzt noch
den breiten Schlüsselbereich `bull:vns:*`. Dieser wird hier nicht verändert.
Eine vollständige wechselseitige Queue-Isolation erfordert eine separat
geprüfte Änderung am Altbestand.
