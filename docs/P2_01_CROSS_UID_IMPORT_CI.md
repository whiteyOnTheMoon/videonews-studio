# P2-01: echter Linux-UID-Handoff-Import (isolierter GitHub-CI-Test)

**Status:** Ausschließlich synthetischer Einweg-Test; keine Änderung an Produktion, VPS, IONOS-Backups oder Beszel.

Die CI baut den vorhandenen TypeScript-Worker und prüft mit echten numerischen
Linux-Identitäten die bisher nur isoliert getestete Kette:

1. In einem temporären Testverzeichnis erzeugt UID 0 einen synthetischen
   Ed25519-Schlüssel und einen mit den bestehenden Projektfunktionen
   `prepareDormantSourceExport` / `sealDormantSourceExport` signierten Quellenexport.
2. Publisher-Private-Key liegt ausschließlich unter UID/GID 10001, Verzeichnis
   0700, Schlüssel 0400. Die Stage gehört UID 10003 / GID 10002, mit Modus
   0750 für das Verzeichnis und 0640 für die signierte Datei. Ein
   Public-Key liegt als root:GID10002 mit 0440 vor.
3. Ein **tatsächlicher, neuer Linux-Prozess** läuft unter UID/GID 10002 und
   bestätigt, dass er den privaten Signierschlüssel nicht lesen kann.
   Derselbe Prozess verwendet den bereits existierenden produktiven Importcode
   `importSignedSourceHandoff` und erzeugt eine private Inbox-Datei 0600.
4. Der Worker verweigert ohne explicit Bootstrap das erstmalige
   `acceptDormantSourceFile`. Im isolierten Test erlaubt ein synthetischer
   in-memory Revisionsanker die erste Annahme, die einen 0600-Checkpoint
   anlegt; beide Revisionswerte werden überprüft.
5. Ein manipuliertes signiertes Export-Bundle wird im echten
   UID10002-Prozess abgelehnt; es entsteht weder eine Inbox-Datei noch ein
   Checkpoint.

Die synthetische Testoberstruktur ist nur für das Abbilden der
**separaten Docker-Bind-Mounts** für UID10002 durchsuchbar; das reale
Host-Basisverzeichnis bleibt root-owned 0700. Keine Produktions-Secrets,
keine echten Feed-URLs, keine DNS-/Netzwerkaufrufe, keine SQL-/Redis-Schreibzugriffe.

## Abgrenzung

Das ist **kein** Nachweis für einen tatsächlich montierten Docker-Container,
keine Freigabe von Quellenrechten, kein überprüfter externer TLS-Revisionsanker,
kein produktiver Checkpoint-Bootstrap und keine vollständige P2-Abnahme.
Der in-memory CI-Anker darf auf dem VPS niemals anstelle des separat
geschützten, persistenten Revisionsankers eingesetzt werden.

Dieser Test dient dazu, falsch konfigurierte Linux-UIDs, Gruppenrechte,
Einsicht in Publisher-Schlüssel, ungültige Signaturen und Schreiboperationen
an Worker-Daten in einer echten prozessübergreifenden Umgebung aufzudecken.
Die Deployment-Gates und betriebliche Freigabe bleiben ausdrücklich separat.
