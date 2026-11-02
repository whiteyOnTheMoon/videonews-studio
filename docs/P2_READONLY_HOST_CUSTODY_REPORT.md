# P2 – Einmalige, rein lesende VPS-Inventur

**Keine Aktivierung und keine Freigabe zur Produktion.**

Der neue Helfer `scripts/p2_readonly_host_custody_report.py` bündelt
die bisher getrennten Read-only-Prüfungen für den gepinnten
`main`-Commit, die vorhandenen Docker-Dienste sowie die lokalen
Eigentümer und Dateirechte für signierte Quellen und die fünf
vorhandenen Feed-Laufzeitpasswörter.

Nach unabhängigem Review des Releases, als angemeldeter VPS-Betreiber:

```bash
cd /home/ap/www/videonews-studio
sudo python3 scripts/p2_readonly_host_custody_report.py \
  --expected-sha FREIGEGEBENER_40_STELLIGER_MAIN_SHA
```

Der Befehl liest **keine Passwortwerte, privaten Schlüssel, signierten
Exportinhalte, Nachrichtenartikel, PostgreSQL-Tabellen oder Redis-Keys**.
Er erstellt keine Dateien, verändert keine Berechtigungen, öffnet keine
SSH- oder Netzwerkverbindung und startet keine Container. Die
Docker-Abfrage ist allein `docker ps --all` mit festem Projektfilter,
Git wird ausschließlich lokal und schreibgeschützt abgefragt.
Es werden nur benannte Wahrheitswerte und ein allgemeiner Status als
JSON ausgegeben; keine Host-Dateipfade, URLs oder Secret-Inhalte.

Die bislang separat gesicherte externe PostgreSQL-Ankerinstanz,
TLS-Revisionsbindung, Ed25519-Inhaltsprüfung, Quellen-Nutzungsrechte,
Feed-Ende-zu-Ende-Canary, Admin-Anmeldung und ein tatsächlicher
Beszel-Alarmeingang können durch diese Dateiinventur **nicht**
bewiesen werden. Jeder dieser Punkte bleibt ausdrücklich
`not_verified`. Selbst bei einem durchgehend positiven Bericht
bleibt `production_authorized=false`.

`read_only_metadata_preflight=incomplete` ist normal, wenn die
Übergabe an den Worker oder dessen Checkpoint noch nicht stattgefunden
haben. Weder einen Checkpoint künstlich erstellen noch einen
Revisionsanker zurücksetzen oder Passwörter erneut installieren,
um den Bericht grün zu machen.

Die erweiterten Stage-A-Prüfungen berücksichtigen jetzt zusätzlich
die Dienste `source-publisher`, `source-handoff-import`,
`feed-project-once` und `feed-project-continuous`, sodass
unerwartet freigegebene Host-Ports dieser Dienste nicht länger
außerhalb der Read-only-Inventur liegen.

Alle Tests nutzen synthetische Dateimetadaten und rufen weder
Docker auf dem VPS noch PostgreSQL oder eine echte Newsquelle auf.
