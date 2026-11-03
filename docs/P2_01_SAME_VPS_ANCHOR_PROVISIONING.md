# P2-01 – Kontrolierter Ein-VPS-Anker: geprüfter Operatorablauf

**Betriebsvorgabe:** Nur der vorhandene VPS, die bestehende PostgreSQL-17-
Datenbank \`videonews\`, IONOS-Backups und Beszel. Keine zweite Instanz.
Der Anker ist **nicht** unabhängig gegen einen vollständigen VPS-Rollback.
Das ist die ausdrücklich gewählte geringere Schutzstufe.

## Code und Zustandsgrenzen

\`scripts/p2_01_same_vps_anchor.py\` enthält fünf strikt getrennte Aktionen:

- \`--preflight\`: ausschließlich lesende Release-, Docker-, Quellen-/Hostaudit-,
  Policy- und SQL-Abwesenheitsprüfung; erwartet den bestehenden sauberen
  Single-Owner- und 0061-Stand.
- \`--install\`: nur nach exakter SHA- und Operatorfreigabe. Erzeugt eine
  private, neue LOGIN-Passwortdatei (0600, UID1000), leitet daraus einen
  SCRAM-SHA-256-Verifier ab und installiert in **einer einzigen SQL-Transaktion**
  vier vorhandene Authority-SQL-Dateien, einen NOLOGIN-Eigentümer,
  einen minimalen LOGIN, den geprüften Quell-/Host-High-Water,
  die separat persönlich bestätigte Signaturrichtlinie und zwei
  EXECUTE-only-Rechte. Kein Reset und kein Retry.
- \`--verify\`: kontrolliert den gespeicherten Zustand und effektive
  SQL-Rechte ausschließlich lesend.
- \`--handoff\`: gesondert durch \`sudo\` und ein genaues ACK autorisierte
  einmalige Übergabe des bestehenden Passworts in ein getrenntes,
  root-privates Verzeichnis, Datei 0400/UID10002. Bestehende
  fünf Feed-Secrets und deren eigene Inventur werden **nicht verändert**.
- \`--verify-handoff\`: read-only Dateirechte- und bytegenauer Abgleich;
  keine Secrets werden ausgegeben.

Alle Befehle müssen im geprüften, sauberen \`main\` ausgeführt werden.
Vor \`--install\` den genauen Release-SHA und die aktuellen
\`p2_01_anchor_bootstrap_candidate.mjs\`-Werte erneut vergleichen. Diese
dürfen nicht aus einer ungeprüften Feed-Konfiguration kommen.

## Erste read-only Prüfung – VPS-Betreiber \`ap\`

Der folgende Block verwendet ausschließlich den zuvor am 2. November
geprüften **Beispielkandidaten**. Bei einer zwischenzeitlichen Änderung des
Quellenexports darf er nicht unverändert übernommen werden.

\`\`\`bash
cd /home/ap/www/videonews-studio
python3 scripts/p2_01_same_vps_anchor.py --preflight \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --source-revision 8 --host-revision 7 \
  --envelope-sha256 41206305bbdee718adf011f8faa91485e8f9bfaadbd3d9d4a776016fc9f9e6e9 \
  --policy-revision 1 \
  --policy-sha256 bc2e875d1e01d3d311587f54b1a9559a91f0b42e17a4102073babfb0912683ed
\`\`\`

## Installation nur nach eigener Freigabe

Nach erfolgreichem, unverändertem Preflight:

\`\`\`bash
cd /home/ap/www/videonews-studio
VNS_P2_SAME_VPS_ANCHOR_OPERATOR_APPROVED=INSTALL_ONE_LOCAL_SOURCE_ANCHOR_ONLY \
VNS_P2_SAME_VPS_ANCHOR_EXPECTED_SHA=FREIGEGEBENER_MAIN_SHA \
python3 scripts/p2_01_same_vps_anchor.py --install \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --source-revision 8 --host-revision 7 \
  --envelope-sha256 41206305bbdee718adf011f8faa91485e8f9bfaadbd3d9d4a776016fc9f9e6e9 \
  --policy-revision 1 \
  --policy-sha256 bc2e875d1e01d3d311587f54b1a9559a91f0b42e17a4102073babfb0912683ed
\`\`\`

\`--install\` ist ein **schreibender PostgreSQL-Sicherheitsvorgang**.
Keine automatische Ausführung durch GitHub. Bei Fehlern oder
unbestätigtem Commit-Status **nicht erneut ausführen**. Die getrennt
angelegte Passwortdatei bleibt absichtlich erhalten, damit ein
authentifizierter Betreiber ohne Rotation abgleichen kann.

Im Anschluss zuerst mit genau denselben Kandidaten \`--verify\` statt
\`--preflight\` aufrufen. Nur bei PASS:

\`\`\`bash
sudo python3 scripts/p2_01_same_vps_anchor.py --handoff \
  --expected-sha FREIGEGEBENER_MAIN_SHA \
  --approval HANDOFF_ONE_EXISTING_ANCHOR_PASSWORD_ONLY

sudo python3 scripts/p2_01_same_vps_anchor.py --verify-handoff \
  --expected-sha FREIGEGEBENER_MAIN_SHA
\`\`\`

Anschließend muss die Compose-Dateivariable
\`VNS_P2_ANCHOR_DB_PASSWORD_FILE\` auf die
root-private Datei \`/var/lib/videonews-studio/p2-anchor-runtime-secret/vns_feed_source_anchor_password\`
zeigen. Es wird weder der bestehende 5-Secrets-Katalog geändert
noch ein Ankerpasswort zu GitHub oder Chat übertragen.

## Sicherheitsgrenzen und nächster Akzeptanzpunkt

Der reale Worker prüft vor einem Feedabruf wieder die eigene
PostgreSQL-Identität, die zwei geschützten SQL-Funktionen und die
signierte Quelle. Nach einer Datenwiederherstellung müssen lokale
High-Water-Werte und Worker-Checkpoint persönlich abgeglichen werden;
die gemeinsame Datenhaltung verhindert sonst keinen koordinierten
Rollback. Der produktive Erstlauf bleibt bewusst \`single_pass\`,
der Worker-Checkpoint darf **nur von diesem** gesetzt werden.

Dieses Paket startet noch keine Queue, Scheduler, Consumer, HTTP-Abfrage,
KI-Ausführung oder Veröffentlichung. Der echte E2E-Feed-Abgleich
und Admin-Ranking gehören zur nachfolgenden Betreiberabnahme.
