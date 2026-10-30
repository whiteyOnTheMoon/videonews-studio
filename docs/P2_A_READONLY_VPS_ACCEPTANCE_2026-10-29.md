# Paket A: lesender VPS-Preflight für Migrationen, Quellen und Ranking

**Status:** Diagnosewerkzeug, kein Deployment und keine Produktionsfreigabe.
Die auf dem VPS tatsächlich installierte Version ist bislang nicht
nachgewiesen. IONOS-Backups und Beszel bleiben unverändert.

## Einmaliger lesender Aufruf

Nach einem **separat genehmigten**, kontrollierten Checkout des
tatsächlich beabsichtigten Release-Commits auf dem VPS:

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p2_a_readonly_acceptance.py \
  --repo /home/ap/www/videonews-studio \
  --expected-sha "$(git rev-parse HEAD)"
```

**Wichtig:** Der eingesetzte SHA muss unabhängig gegen den
freigegebenen GitHub-Release überprüft werden. Der oben gezeigte
Befehl kontrolliert nur, dass der auf dem Host ausgecheckte Commit
mit dem angegebenen SHA übereinstimmt. Er beschafft keine Freigabe.

Das Werkzeug verlangt das unveränderte ausgecheckte Release und
prüft zunächst die bestehende lesende Stage-A-Inventur.
Anschließend werden zwei fest vorgegebene PostgreSQL-Abfragen im
Compose-Container `videonews-studio-postgres-1` ausgeführt.

Die `psql`-Sitzung verwendet `-X -w`, einen kurzen
Statement-/Lock-Timeout und
`default_transaction_read_only=on`. Damit sind weder
Migrationen noch DB-Änderungen, Credentials, externe HTTP-Aufrufe
oder Worker-Neustarts Teil der Diagnose. Raw-Datenbankfehler
und Rohlogs werden nicht ausgegeben.

## Maschinenprüfungen

- Git-Checkout und bereits vorhandene Stage-A-Docker-Prüfungen
  müssen ein unverändertes, erwartetes Release bestätigen.
- PostgreSQL muss im zugeordneten Compose-Projekt laufen,
  gesund und ohne veröffentlichte Host-Ports sein.
- Alle Migrationen `0001` bis `0059` müssen in exakt der
  versionsgebundenen Reihenfolge installiert sein. Bereits ein
  fehlender oder zusätzlicher Eintrag sperrt die Prüfung.
- Das persönliche Quellenregister muss drei bis fünf explizit
  auf `approved` gesetzte Quellen enthalten. Alle diese
  Quellen müssen **gegenwärtig** die Laufzeit-Quellen- und
  Hostfreigaben bestehen.
- Die aktuelle Registerrevision muss mindestens drei
  verschiedene persönlich überprüfte Publisher-Gruppen
  enthalten. Ein Quellenname allein belegt keine Unabhängigkeit.
- Es müssen geprüfte Ranking-Policies, Event-Faktoren und
  mindestens ein persistierter **gewichteter, unveröffentlichter**
  Nachrichtenkandidat vorliegen.
- Eine gespeicherte Ranking-Zeile mit
  `approved_for_publication=true` sperrt die Prüfung.
  Rankings können dadurch nicht veröffentlicht werden.

Das JSON-Ergebnis zeigt ausschließlich Prüfnamen,
aggregierte Zählwerte, `reviewable` oder `blocked`
sowie einen expliziten Hinweis
`production_authorized: false`. Fehlende Migrationen,
Datenbankrechte, Docker-Berechtigungen, fehlende Quellen oder
ungültige Rückgaben führen zu `blocked` und Exit-Code 2.
Bei `reviewable` lautet der Exit-Code 0, aber dies ist
**noch immer keine vollständige Produktionsabnahme**.

## Unabhängig weiterhin nachzuweisen

Die Diagnose kann **nicht** die tatsächlichen Nutzungsrechte
jedes Feed-Eintrags, die persönlichen Admin-Sitzungen, die
Integrität konkreter Nachrichten, reale HTTP-Feedabrufe,
Neustarts und Fehlerfälle oder das manuelle redaktionelle
Prüfergebnis bezeugen. Diese Punkte werden im Bericht
immer als `not_verified` ausgegeben, auch wenn sämtliche
statistischen Datenbankprüfungen bestanden werden.

Insbesondere sind die drei vorgeschlagenen NASA/JPL-, NOAA-
und USGS-Feeds bislang **nicht persönlich freigegeben**.
Die Bedingungen sowie der persönliche, unabhängige
Freigabepfad stehen in
`docs/P2_A_OFFICIAL_FEED_RIGHTS_REVIEW_2026-10-29.md`.

Die existierenden Backup-/Beszel-Angaben des Betreibers
werden durch den Preflight nicht verändert oder in Frage
gestellt. Aus einem grünen Read-Only-Bericht folgt keine
Berechtigung, Secrets zu erzeugen, Migrationen zu starten,
Quellen zu aktivieren oder Veröffentlichungen zuzulassen.
