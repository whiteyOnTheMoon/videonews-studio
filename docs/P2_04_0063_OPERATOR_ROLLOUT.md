# P2-04 / Migration 0063 – personenbezogener Admin-Nachrichteneingang

**Status: Code, keine VPS-Ausführung. Keine Veröffentlichung von Nachrichten oder Videos.**

Das neue Python-Operatorwerkzeug scripts/p2_04_schema_0062_to_0063.py
ist getrennt von Feed-Produktion, Projektor, Redis, Scheduler sowie API-/Web-Deployment.
Es übernimmt ausschließlich die bereits geprüfte Migration 0063 für die
persönlich angemeldete interne Admin-Eingangsansicht.

## Voraussetzungen

- Ein vollständig überprüfter GitHub-main-Commit muss als sauberes, genau passendes
  Arbeitsverzeichnis unter /home/ap/www/videonews-studio vorliegen; ausführender
  Linux-Nutzer ist ap (UID 1000), Git-Index gehört ap:ap mit 0600.
- Das vorhandene Compose-PostgreSQL muss gesund sein, Schema 0062 vollständig
  installiert, Migration 0063 nicht installiert, alle laufenden Feed-/Projektor-
  und Publisher-Services gestoppt. Keine Reparatur oder Neustarts durch das Tool.
- Die Betreiberin oder der Betreiber muss die Wiederherstellbarkeit eines
  externen Backups eigenständig prüfen. Das Tool kann IONOS-Backups und
  Datenbank-Restore nicht selbst attestieren.
- Die Quellenrechte und die aktuelle persönliche Editor-Anmeldung werden
  nicht geändert. Eine fehlende Quellenfreigabe wird nicht durch das neue
  Schema ersetzt.

## Erst ausschließlich lesend

Den **konkret geprüften** 40-stelligen Hauptbranch-Commit einsetzen. Nicht
mittels ungeprüftem dynamischem HEAD ersetzen und nicht sudo verwenden.

    cd /home/ap/www/videonews-studio
    python3 scripts/p2_04_schema_0062_to_0063.py \
      --status --expected-sha EXAKTER_MAIN_SHA
    python3 scripts/p2_04_schema_0062_to_0063.py \
      --preflight --expected-sha EXAKTER_MAIN_SHA

Status akzeptiert exakt Schema 0062 oder 0063, kontrolliert Rollen und
Ausbleiben von Veröffentlichungsfreigaben. Preflight akzeptiert nur 0062
und prüft die unveränderte Quellen-, Host-, Audit- und Artikel-Aggregatstruktur.
Es wird keine Quelle abgefragt, kein Docker-Container erzeugt, kein SQL
geschrieben und keine Nachricht veröffentlicht.

## Nur nach überprüfter externer Backup-/Recovery-Bereitschaft

Der schemaändernde Aufruf ist standardmäßig gesperrt und benötigt **alle**
drei Bestätigungen. Erst nach erfolgreichem read-only Preflight und
Betreiberkontrolle von Recovery und Live-Diensten:

    VNS_P2_0063_SCHEMA_OPERATOR_APPROVED=INSTALL_PERSONAL_ADMIN_INBOX_SCHEMA_ONLY_NO_PUBLICATION \
    VNS_P2_0063_EXPECTED_MAIN_SHA=EXAKTER_MAIN_SHA \
    VNS_P2_0063_RECOVERY_VERIFIED=OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_ROLLBACK \
      python3 scripts/p2_04_schema_0062_to_0063.py \
        --apply --expected-sha EXAKTER_MAIN_SHA

Dies schreibt **nur** die 0063-DDL und Berechtigungen sowie die Schema-
Migrationstabelle, keine Nachrichtentexte, keinen Ranking-Score und keine
Quellen-/Host-Freigabe. Bei mehrdeutigem Ergebnis sofort abbrechen,
den Zustand neu untersuchen und keinesfalls einen zweiten
Apply-Aufruf oder automatischen Rollback versuchen.

## Gesonderter API-/Web-Schritt

Ein grüner 0063-Status bringt nicht selbst die Oberfläche live. Vor dem
separaten, versionierten Release müssen vorhandene API-/Web-Container,
geschützte Editor-Sitzung, personalisierte PostgreSQL-Logins und
Laufzeitkonfiguration geprüft werden. Dieser Teil wird unabhängig vom
Schema-Update geplant. Der Admin-Nachrichteneingang gibt ausschließlich
ungeprüfte Metadaten aus; Veröffentlichung bleibt auch nach dem Rollout
verboten.

## CI

Offline-Python-Tests prüfen Preflight, fehlende Freigaben, falsche SHA,
Backup-Sperre, einmaligen Schema-Write, Widerstand gegen Wiederholung und
fail-closed Verhalten bei einem mehrdeutigen Commit. Die bereits grüne
separate Wegwerf-PostgreSQL-17-CI testet den echten SQL-Stand 0001–0063,
rollenbezogene Anzeige, Host-Widerruf, Rollback und Wiederanwendung.
