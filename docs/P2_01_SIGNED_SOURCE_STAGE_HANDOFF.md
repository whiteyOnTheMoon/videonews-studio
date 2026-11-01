# P2-01: eingeschränkte einmalige Staging-Übergabe für den signierten Quellenexport

**Status: GitHub-Implementierung zur Prüfung; keine VPS-Änderung und keine Freigabe eines Feed-Abrufs.**

Der signierte Quellenexport kann nicht direkt aus dem privaten Publisher-Verzeichnis
(UID 10001, 0700) vom Worker (UID 10002) eingelesen werden. Der ausschließlich
durch den Betreiber startbare Helper
`scripts/p2_01_signed_handoff_stage.mjs` erstellt deshalb **einmalig**
`/var/lib/videonews-studio/p2-signed-source/handoff-staging` (0750,
UID 10003, GID 10002) und eine unveränderte, gruppenlesbare Kopie
`source-export.signed.json` (0640, UID 10003, GID 10002).

## Zulassungsgrenzen

- Root-only, exakt gepinnter GitHub-main-SHA und sauberer Checkout, keine
  vorhandenen Feed-/Publisher-/Import-Container. Kein Remote-Git-Zugriff
  als root; der Betreiber muss den freigegebenen main vorab separat prüfen.
- Quelle und getrennt gespeicherter öffentlicher Ed25519-Schlüssel müssen
  echte Dateien mit den festgelegten Eigentümern und Rechten sein.
  Signatur, Format und SHA-256-Integrität werden **vor jeder Schreiboperation**
  geprüft. Der private Signierschlüssel wird niemals geöffnet.
- Die beiden Worker-Verzeichnisse müssen leer sein. Das Übergabeverzeichnis
  muss vollständig fehlen. Bestehende oder teilweise angelegte Stages werden
  **niemals überschrieben oder automatisch repariert**.
- Zuerst entsteht das Verzeichnis ausschließlich root-lesbar (0700).
  Der fertige Dateiinode wird mit UID/GID, 0640 und fsync gespeichert.
  Erst danach wird das Verzeichnis UID 10003:GID 10002 mit 0750 übertragen.
  Anschließend folgt ein bytegenauer, schreibgeschützter Vergleich.
- Keine HTTP-, Redis-, PostgreSQL- oder externen Trust-Anchor-Aufrufe.
  Kein Worker, Scheduler, Docker-Start, SQL-Commit oder Publishing.
  **Diese Stufe ist nicht gleichbedeutend mit einer Quellenfreigabe.**

## Vorgesehene Ausführung (erst nach PR-Review und genehmigtem Release)

Am VPS als Unix-Benutzer `ap` den beabsichtigten GitHub-main-SHA unabhängig
prüfen und den unveränderten Stand bestätigen. Dann, unter lokaler
authentifizierter sudo-Freigabe:

```bash
sudo node scripts/p2_01_signed_handoff_stage.mjs \
  --preflight --expected-sha FREIGEGEBENER_40_ZEICHEN_SHA
```

Bei PASS kann der Betreiber die exakt begrenzte einmalige Dateikopie
gesondert autorisieren:

```bash
sudo node scripts/p2_01_signed_handoff_stage.mjs \
  --install --expected-sha FREIGEGEBENER_40_ZEICHEN_SHA \
  --approval STAGE_ONE_EXISTING_SIGNED_SOURCE_EXPORT_ONLY
sudo node scripts/p2_01_signed_handoff_stage.mjs \
  --verify --expected-sha FREIGEGEBENER_40_ZEICHEN_SHA
```

Bei irgendeinem REFUSED **nicht blind wiederholen**: die Staging-Struktur
zuerst nur lesend diagnostizieren. Niemals die private Schlüsseldatei,
vollständige Quellen-JSON oder andere Secrets in Chat/CI/Tickets ausgeben.

## Weiterhin offene Produktionsvoraussetzungen

Ein späterer, eigenständig autorisierter `source-handoff-import` muss
die Stage als **read-only Bind-Mount** erhalten und die Signatur mit
einem unabhängig vertrauenswürdig gemachten öffentlichen Schlüssel
erneut prüfen. Erst danach darf der Import in die Worker-Inbox erfolgen.
Der separate monotone TLS-Revisionsanker, Checkpoint-Bootstrap,
Quellen-/Host-Nutzungsrechte, echte UID-/Netzwerk-Isolation, Feed-Consumer,
Scheduler, Neustart- und Fehlerfall sowie Admin-Ranking sind damit
**nicht abgenommen**.

Dieser Helper ersetzt keinen unabhängigen Transfer-Daemon und ist bewusst
nur eine einzelne, durch root autorisierte Betreiberkopie. Er gewährt UID 10003
keinen Zugriff auf das private Publisher-Verzeichnis und läuft nicht dauerhaft.
