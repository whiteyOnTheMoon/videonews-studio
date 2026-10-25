# P1-09 – E-Mail-Warnungen (SMTP, vorbereitet; noch NICHT aktiviert)

Refs #9. Der Betreiber hat E-Mail als gewünschten Benachrichtigungskanal
ausgewählt. Dies ist eine **code-only Umsetzung ohne VPS-Aktivierung**.
Der bereits laufende 15-Minuten-Disk-Timer und sein lokales Journal bleiben
unverändert. Weder Mailkonto noch SMTP-Zugang oder Zieladresse sind bislang
eingerichtet oder getestet. Es wurden keine E-Mails gesendet.

## Transport und Datenschutz

- Eigener, separat installierbarer Timer `vns-disk-email.timer` und Dienst
  `vns-disk-email.service`; **nicht automatisch installiert/aktiviert**.
- Python-Standardbibliothek `smtplib.SMTP_SSL`, explizit TLS mit geprüftem
  Zertifikat und fester Port 465. Keine Klartext- oder STARTTLS-Downgradeoption.
- Voraussetzung ist ein bereits vorhandenes Mailkonto, dessen Anbieter
  SMTP über Port 465 unterstützt. Ob kostenlose Nutzung und App-Passwörter
  möglich sind, ist anbieterspezifisch und vor Einrichtung zu prüfen.
- Keine IP-Adressen, lokalen Hostnamen, URLs oder Steuerzeichen als
  SMTP-Host beziehungsweise Mailadresse akzeptiert.
- E-Mail enthält ausschließlich Status und freien Disk-Speicher; keine
  Zugangsdaten, Jobinhalte, Server-IP, SSH-Daten oder Logs.
- Fehlerausgaben sind fest vorgegeben und geben keine SMTP- oder
  Authentifizierungsdetails wieder. Keine secrets in Git/CI/journal.

Die optionalen privaten Konfigurationsdateien unter
`/home/ap/.config/videonews-studio/disk-alert/` sind:

- `email_config.json` (0600), **genau** vier Felder: `smtp_host`,
  `smtp_username`, `email_from`, `email_to`; Elternverzeichnis 0700.
- `email_smtp_password` (0600): SMTP-/App-Passwort, keine Klartextwerte
  im Repository, in Kommandozeilenparametern oder im Chat.

Nur einmalig nach **separater** Freigabe und Konfiguration:

```sh
python3 scripts/p1_09_email_alert.py --check-config
python3 scripts/p1_09_email_alert.py --test-email
```

`--check-config` ist rein lokal und sendet nichts.
`--test-email` sendet bewusst eine einzelne harmlose Testnachricht, ohne
einen Warnzustand zu simulieren oder seinen Status zu verändern.
**Ohne diese bewusste Anforderung gibt es keine SMTP-Verbindung.**

## Warnungsstrategie

Eine separate Statusdatei verhindert doppelte E-Mails:

- Initialer OK-Zustand: keine Nachricht.
- Erste WARN-, CRITICAL- oder UNKNOWN-Messung: E-Mail.
- Wechsel der Warnstufe: neue E-Mail.
- Unveränderter Warnzustand: maximal alle sechs Stunden erneut.
- Entwarnung nach vorherigem Warnzustand: genau eine E-Mail.
- Fehlgeschlagener Versand: kein Zustell-Eintrag; Folgeprüfung versucht erneut.
- Exklusiver Lock verhindert parallele Sendeläufe.

Das Versandprogramm benötigt explizit `--send`; die neue separate systemd
Unit trägt dieses Flag. Sie ist durch unprivilegierten Benutzer,
`ProtectSystem=strict`, `ProtectHome=read-only`, `StateDirectory`,
`NoNewPrivileges`, eingeschränkte Fähigkeiten und Ressourcen begrenzt.
**Anders als der lokale Disk-Watch benötigt sie Netzwerkzugang.**

Systemd speichert ihren Status ausschließlich unter
`/var/lib/vns-disk-email` mit Berechtigung 0700.
Die Laufzeit legt dort ausschließlich einen Lock und eine 0600-Statusdatei an.
Der lokale Disk-Watch-Dienst bleibt bewusst isoliert mit PrivateNetwork=yes.

## Rollout-Reihenfolge (NICHT in diesem PR ausführen)

1. SMTP-Anbieter und eine Empfängeradresse auswählen. Keine Passwörter
   oder vollständige SMTP-Credentials im Chat veröffentlichen.
2. Sicherheits- und Kostenbedingungen des vorhandenen Mailkontos prüfen;
   gegebenenfalls ein eigenes App-Passwort lokal erstellen.
3. Private Konfiguration auf VPS mit geprüften Eigentümern/Rechten ablegen.
4. Lokal `--check-config`, dann **mit gesonderter Zustimmung** eine
   `--test-email`-Nachricht versenden und deren Eingang bestätigen.
5. Erst danach beide systemd-Units gesondert installieren, prüfen und
   `vns-disk-email.timer` aktivieren; bisherigen Timer unverändert lassen.
6. Eine echte Warnungszustellung mit **synthetischen, offline injizierten**
   Tests ist bereits in CI abgedeckt; Live-Alarmketten müssen ohne Fälschen
   von produktiven Disk-Werten gesondert abgenommen werden.

Bei ausbleibenden E-Mails liefert der lokale Timer weiter Journal-Meldungen.
Ein SMTP-Server kann eine Annahme quittieren, obwohl die spätere Zustellung
in den Posteingang scheitert. Der Test-E-Mail-Eingang ist daher wichtig.

## Noch offen

Kein Echtversand, keine SMTP-Anbieterfreigabe, keine Installation, keine
Benachrichtigungsgarantie. Reale Token-/Kostenbuchung, überprüftes
Offsite-Backup und Restore bleiben in #9 offen.
