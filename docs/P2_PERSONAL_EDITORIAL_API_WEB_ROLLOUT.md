# P2: Persönliche Editorial-API und Admin-Webansicht getrennt zulassen

**Produktivstatus:** Ein bereits vorhandener persönlicher Admin wurde
auf dem VPS mit PostgreSQL `editor_vns_owner_admin` authentifiziert.
Die persönlich zugeordnete SQL-Identität, das sichere Secret und die
`vns_p2_named_client`-Mitgliedschaft wurden tatsächlich geprüft.
**Weder API noch Web sind damit automatisch aktualisiert/aktiviert.**

## Implementierte Opt-in-Konfiguration

`deploy/compose.personal-editorial-admin.yaml` deklariert jetzt
zwei **separat standardmäßig ausgeschaltete** Gates:

- `web`: `VNS_WEB_EDITORIAL_ADMIN_ENABLED`, Default `false`.
  Zusätzlich braucht der vorhandene Web-BFF die bisherige
  persönliche Editor-Anmeldung
  `VNS_WEB_EDITOR_AUTH_ENABLED=true` sowie die vorhandenen
  Admin-Proxy-Voraussetzungen. Dieses Overlay verändert diese
  bestehenden Gates ausdrücklich **nicht**.
- `api`: `VNS_EDITORIAL_PERSONAL_DB_ENABLED` und
  `VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK`, beide Default
  `false`. Der API-Server kann den persönlichen
  Editor nur bei vorhandenen Editor/Auth-Instanzen montieren.
  Pro HTTP-Anfrage wird eine neue, persönlich authentifizierte
  PostgreSQL-Verbindung aufgebaut; `session_user` wird gegen
  den bestehenden Editor und `auth_version` verifiziert.

Das API-Overlay bindet ausschließlich das bereits angelegte
private Hostverzeichnis unter
`/run/secrets/vns_editor_credentials` **read-only**. Es
veröffentlicht keine Ports und erzeugt keine neuen Redis-, Feed-
oder Publishing-Berechtigungen. Das Dockerfile startet die API
als `node` (UID 1000); auf dem VPS wurde das separate Owner-
Credential mit UID 1000, `0700`-Verzeichnis und `0600`-
Dateimodus erzeugt. Die Rechte müssen nach jedem Änderungslauf
erneut geprüft werden.

## Vor jedem kontrollierten Build/Deployment

1. Vorliegendes Release und alle in Betrieb befindlichen
   `web`/`api`-Container samt deren tatsächlich verwendeten
   Image-Digests separat prüfen. Ein Git-Checkout ist **kein**
   laufender Container-Release.
2. Das bereits bestätigte IONOS-Backup und Beszel weiter nutzen,
   ohne weitere Dienste anzulegen. Für einen geplanten
   Neustart/Rollback die bisher funktionsfähigen P1-Images
   unangetastet verfügbar halten.
3. Secret nur anhand von `stat`-Metadaten prüfen; keine
   Passwortdateien in Chat, Compose-Ausgaben oder Logs kopieren.
4. Overlay-Konfiguration ohne Ausgabe privater Konfiguration
   validieren, etwa:

   ```bash
   cd /home/ap/www/videonews-studio
   VNS_P2_EDITORIAL_PERSONAL_CREDENTIALS_DIR=\
   /home/ap/www/videonews-studio/secrets/p2-editorial-personal \
     docker compose -f compose.yaml \
       -f deploy/compose.personal-editorial-admin.yaml \
       config --quiet
   ```

   Diese Prüfung schaltet nichts ein und startet keine Container.
5. Für die tatsächliche Freischaltung braucht es einen separaten,
   konkreten Operator-Entscheid über die **laufenden Images**,
   die beiden API-Flags, das Web-Gate und die erneute
   persönliche Anmeldung im Browser. Kein generisches
   `docker compose up -d` für alle Services ausführen.

## Reale Abnahme nach expliziter Freischaltung

- API mit neu gebautem/geprüftem Release starten; prüfen, dass
  der Auth- und Editor-Runtimepfad bereit ist und die geschützten
  Editorial-Endpunkte nicht ohne gültige persönliche Sitzung
  erreichbar sind.
- Web desselben Releases mit separatem Editorial-Gate starten;
  mit bestehendem persönlichen Admin-Cookie redaktionelle
  Profil- und Timeline-**Lesefunktionen** prüfen und den
  Ergebnistyp sicher validieren.
- Einen bewusst ausgewählten, revisionsgesicherten
  administrativen Testeintrag erst nach gesonderter
  Redaktionsfreigabe anlegen, über das Admin lesen und den
  zugeordneten Autor in PostgreSQL bestätigen.
- Weder `VNS_WEB_SOURCE_REGISTRY_ENABLED` noch
  `VNS_WEB_HOST_APPROVAL_ENABLED` aktivieren: die zugehörigen
  API-Handler sind am produktiven Entry Point noch nicht
  angeschlossen und benötigen eine gesonderte
  identitätsgebundene SQL-Schreibschnittstelle.
- Es werden weiterhin weder echte Quellen noch eine zweite
  unabhängig prüfende Person durch einen Feature-Flag
  eingerichtet. Die Quellen- und Hostregister müssen
  unverändert Revision 0 bleiben, bis die echten
  Nutzungs-/Quellenfreigaben ausdrücklich vorliegen.

**Grenze:** Die Aufnahme des persönlichen PostgreSQL-Logins
und grüne Offline-Tests ersetzen noch keinen tatsächlichen
API-/Web-Rollout oder eine Anmeldung im laufenden Admin-Tool.
