# P1-09 — Zentrales VPS-Monitoring mit Beszel

**Entscheidung 2026-10-25:** Der Betreiber hat bestätigt, dass Beszel bereits
serverweit genutzt wird und Benachrichtigungen erhält. Für VideoNews Studio
werden daher **keine zusätzlichen eigenen Festplatten-Timer, E-Mail- oder
Telegram-Benachrichtigungsdienste** betrieben. Diese Entscheidung ersetzt
die zuvor entwickelten P1-09-Disk-Watch- und SMTP/Telegram-Experimente.

## Betrieb und Verantwortlichkeit

- **Beszel** ist die übergreifende Beobachtungsschicht auf VPS-Ebene.
  Zuständig: bestehende, vom Betreiber verwaltete Beszel-Hub-/Agent-Instanz.
  Kein zusätzlicher Beszel-Container, Agent oder fremdes Docker-Netzwerk wird
  in diesem Repository eingerichtet, verändert oder neu gestartet.
- Beszel unterstützt historisierte Host-CPU-, RAM-, Speicherplatz-, Netzwerk-
  und Docker-/Podman-Metriken sowie regelbasierte Benachrichtigungen.
  Dokumentation: https://beszel.dev/guide/what-is-beszel
- Die bereits vorhandenen **PostgreSQL-/Redis-/Docker-Healthchecks** bleiben
  erhalten. Beszel ergänzt ihre Beobachtung; es ersetzt nicht automatisch
  anwendungsspezifische API-, Queue- oder Datenbanktests.
- **Host-Speicherplatz** ist das primäre Ziel der früheren P1-09-Schwellen.
  Wenn der Agent den betreffenden Root-/VPS-Datenträger erfasst, kann
  Beszel hierfür einen Disk-Usage-Alarm verwenden.
- CPU/RAM, Containerzustände und Netzwerk sind ergänzende VPS-Indikatoren.
  Beszel liefert keine echten KI-Provider-Tokens, Jobkosten oder
  Abrechnungsdaten; dafür bleibt das getrennte P1-09-Kostenmodell erhalten.

## Konfiguration und Verifikation (keine Änderungen durch diesen PR)

Der Betreiber hat Beszel als aktiv und für ihn ausreichend gemeldet.
**Nicht unabhängig geprüft** sind in diesem GitHub-Änderungssatz:
Hub-Version, aktiver Agent, konkrete VideoNews-Container-Sichtbarkeit,
gewählte Warnschwellen und erfolgreiche Testbenachrichtigungen. Diese
Details dürfen nicht als bestandener Live-Test dargestellt werden.

Bei einer späteren Bestandsaufnahme **in der bestehenden Beszel-Oberfläche**:

1. Den VPS als erreichbares System und den erfassten Root-Datenträger prüfen.
2. Kontrollieren, dass die relevanten VideoNews-Container in den
   Docker-Metriken erscheinen, soweit der Beszel-Agent Containerzugriff hat.
3. In der Systemübersicht die gewünschten Disk-/Status-/CPU-/RAM-Alarme
   prüfen (Glockensymbol bzw. System-Alarmoptionen). Der Betreiber wählt
   die Schwellen; historische eigene Prüfwerte von 20/10 GiB und 15/8 %
   werden **nicht automatisch** als Beszel-Konfiguration übernommen.
4. Unter **Settings > Notifications** den bestehenden Zustellweg prüfen.
   Keine Zugangsdaten, Notification-URLs oder privaten Empfänger in
   GitHub/Chat kopieren. Quelle: https://beszel.dev/guide/notifications/
5. Einen ggf. unterstützten sicheren Zustelltest im bereits vorhandenen
   Beszel-Setup prüfen. Kein produktives Laufwerk künstlich füllen,
   keine Docker-Dienste unterbrechen und keine fremden Projekte verändern.

Beszel selbst, seine Alarmregeln und seine Zugangsdaten sind **außerhalb
dieses Repositories** verwaltet. Dieses Dokument autorisiert keine Änderungen
an der gemeinsam genutzten Monitoring-Infrastruktur.

## Entfernung redundanter VideoNews-Überwachung

Nach erfolgreicher, enger VPS-Deinstallation der VideoNews-spezifischen
`vns-disk-watch.service` und `vns-disk-watch.timer` werden im Repository
die zugehörigen Python-Prüf- und Benachrichtigungsskripte, Offline-Tests,
systemd-Unit-Vorlagen sowie E-Mail-/Telegram-Anleitungsdateien entfernt.
Die optionalen Mail-/Telegram-Timer wurden bislang nur als Code geliefert,
nie installiert, konfiguriert oder aktiviert; der Gmail-Konfigurationslauf
scheiterte vor dem Anlegen eines Verzeichnisses.

**Reihenfolge zwingend:** Erst den laufenden VideoNews-Disk-Timer auf dem VPS
kontrolliert deaktivieren/entfernen, dann diesen GitHub-Cleanup mergen;
andernfalls würde der aktive Timer eventuell auf gelöschte Skripte zeigen.
Beszel- und andere Docker-/systemd-Dienste bleiben unberührt.

## Offene P1-09-Themen

- Reale pro Job erfasste KI-Provider-Tokens und Gebühren, sichere Ingestion
  in `vns.costs`, Preisdefinitionen und spätere Budgetgrenzen sind nicht
  durch Beszel abgedeckt. Das Offline-Kostenmodell wird weiter getestet.
- **Offsite-Backup, unabhängiger Restore und RPO/RTO** sind nicht belegt.
  Beszel-Metriken oder ein Backup seiner _eigenen_ Monitoring-Daten sind
  kein Backup von VideoNews-PostgreSQL-/Redis-/Mediendaten.
- Ein dedizierter VideoNews-Live-Beszel-Alarmtest wird erst nach
  Freigabe und ohne gefährliche oder produktionsstörende Tests durchgeführt.
  Bis dahin basiert die Entscheidung zur ausreichenden Alarmierung auf
  der Aussage des Betreibers.

GitHub-Issue #9 bleibt offen, bis die übrigen Abnahmekriterien erfüllt
oder ausdrücklich angepasst werden.
