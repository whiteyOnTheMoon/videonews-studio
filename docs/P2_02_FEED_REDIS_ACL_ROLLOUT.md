# P2-02: Additive Feed-Redis-ACL – kontrollierter Betreiberablauf

**Status:** GitHub-Code im Review, keine VPS-Änderung. Produktive lesende ACL-Inventur vom 31.10.2026: acl_file_secure=true; acl_user_count=3; default_disabled=true; worker_present=true; provider_producer_present=true; feed_acl_users=0. Drei getrennte PostgreSQL-Service-Logins sind nach dem korrigierten Postcheck produktiv bestätigt. NOAA-Quellen- und Hostfreigabe sind auditiert.

## Ziel

Der neue Helper scripts/p2_02_feed_redis_acl_custody.py ergänzt genau zwei getrennte Redis-Benutzer:

- vns_feed_producer_prod: ausschließlich BullMQ-Feed-Jobs einstellen; kein Zugriff auf SQL, Quellen-HTTP oder Signierschlüssel.
- vns_feed_consumer_prod: ausschließlich BullMQ-Feed-Jobs verarbeiten, mit separater Datenbank- und Quellenprüfung.

Beide ACLs begrenzen Schlüssel und Pub/Sub auf bull:vns:feed:vns-feed-poll:*. Alle anderen Schlüsselräume, etwa bull:vns:vns-jobs:*, bull:vns:vns-research:* und bull:vns:vns-provider-text:*, bleiben verboten. Administrative und gefährliche Redis-Befehle sind ebenfalls untersagt. Die vorhandenen Einträge default, vns_worker und vns_provider_producer bleiben bytegenau unverändert. Der Standardbenutzer bleibt deaktiviert.

## Bedienung nach geprüftem, freigegebenem Release

Alle Schritte erfordern die Operator-UID 1000, einen sauberen main mit dem genauen freigegebenen Release-SHA, einen gesunden Redis-Compose-Container ohne Hostports und einen als 0644 gesicherten ACL-Dateiinode. Das Verzeichnis secrets/ ist 0700. Bei unklarem Ausgang niemals blind wiederholen.

- Stage: python3 scripts/p2_02_feed_redis_acl_custody.py --stage --expected-sha FREIGEGEBENER_SHA. Prüft Release, laufendes Redis und bestehende ACL lesend; erzeugt genau zwei unterschiedliche zufällige Passwörter unter secrets/p2-feed-redis-acl/ (Verzeichnis 0700, Dateien 0600). Bereits existierende Dateien werden niemals überschrieben.
- Preflight: --preflight --expected-sha FREIGEGEBENER_SHA. Prüft die beiden Passwortdateien und bestehenden ACL-Benutzer read-only.
- Prepare: --prepare --expected-sha FREIGEGEBENER_SHA. Erzeugt nur private 0600-Dateien für den **additiven Kandidaten** und einen SHA-256-Schnappschuss der bisherigen ACL. Laufendes Redis und ursprüngliche Host-ACL unverändert.
- Verify: --verify --expected-sha FREIGEGEBENER_SHA. Lesender Vergleich von beiden Dateien, den Passwortdateien, den erwarteten ACL-Zeilen und der Originaldatei.
- Install-file: nur mit der separaten ausdrücklichen Betreiberfreigabe VNS_P2_FEED_REDIS_ACL_INSTALL_APPROVED=INSTALL_TWO_FEED_ACL_USERS_FILE_ONLY und VNS_P2_FEED_REDIS_ACL_EXPECTED_SHA=FREIGEGEBENER_SHA sowie --install-file --expected-sha FREIGEGEBENER_SHA. Der Helper sichert die alte ACL privat, prüft die Datei-/Inode-Basis unmittelbar vor dem Austausch und ersetzt ausschließlich die Hostdatei atomar mit Modus 0644. Weder ACL LOAD noch Redis-Neustart.
- Installed: --installed --expected-sha FREIGEGEBENER_SHA vergleicht ausschließlich lesend die Sicherung, den Kandidaten und die Hostdatei. Bei Fehler keine Wiederholung vor genauer Read-only-Diagnose.

Passwörter verbleiben lokal in privaten Hostdateien. Weder Passwörter noch Passwort-Hashes in Chat, Issues oder Diagnoseausgaben teilen.

## Separater Live-Rollout

Ein Docker-Secret kann nach dem atomaren ACL-Dateitausch weiterhin auf den alten Inode zeigen. Der laufende Redis-Server erhält die neuen ACL-Benutzer erst nach einer **gesondert geplanten und freigegebenen** Redis-only-Recreation und anschließenden Authentifizierungs- und Queue-Scope-Tests. Davor Netzwerk, AOF-Volume, Image-Digest und vorhandene Client-Sitzungen lesend inventarisieren. Keine AOF-Löschung, kein unkontrollierter Restart oder ACL LOAD.

Die neuen Passwortdateien gehören zunächst UID 1000; die späteren Feed-Container unter UID 10002 erhalten sie erst nach eigenem minimalem Secret-Handoff. Offline-CI verwendet ausschließlich synthetische Daten und ein eigenständiges Redis ohne Host-Netzwerk.

Signatur-/Quellenexport, unabhängiger Revisionsanker, echter Feed-Consumer, Projektion, 3–5 geprüfte Quellen und Admin-Anzeige bleiben eigene Aufgaben. Dieser Schritt startet keinen Feed, Scheduler, KI-Anbieter oder eine Veröffentlichung. Die bestehenden IONOS-Backups und Beszel-Kontrollen bleiben unverändert.
