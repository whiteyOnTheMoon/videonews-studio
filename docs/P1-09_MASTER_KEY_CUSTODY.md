# P1-09 – Master-Key-Datei: sichere Lesebedingungen (nur Offline-Tests)

**Status: Git-only / CI. Keine Keys auf dem VPS eingerichtet, kein API-Server
geändert, keine Datenbankmigration, kein neuer Docker-Container.**

Für die spätere sichere Verwaltung von OpenAI-/Gemini-API-Schlüsseln wird
ein separater, 32 Byte langer **Master-Key** (Key-Encryption-Key, KEK)
benötigt. Der Master-Key ist nicht identisch mit einem Anbieter-API-Key.
Er darf nie in Git, Chat, Browser, Docker-Images, Compose-Variablen,
PostgreSQL, Logs oder einer normalen Web-Konfigurationsantwort erscheinen.

## Neu: inaktiver, restriktiver Datei-Leser

`apps/api/src/provider-master-key-file.ts` stellt ausschließlich
`withProviderMasterKey(callback, trustedDirectory)` bereit.
Das Modul wird **nicht** von `server.ts` oder `index.ts` importiert.
Ohne gesonderte Einbindung kann es keinen Schlüssel akzeptieren, erzeugen,
persistieren, rotieren oder für Anbieteraufrufe nutzen.

Der vorgesehene, nicht erzeugte Pfad wäre
`/run/secrets/vns/provider-master-key`. Der Pfad ist serverseitig
festgelegt und darf später **niemals** aus Browserdaten stammen.

Die Funktion prüft vor dem Lesen einer Datei:

- absolutes, kanonisch geschriebenes Verzeichnis ohne finalen Symlink;
- Eigentümer muss dem effektiven Prozess-UID entsprechen;
- Verzeichnis ohne Gruppen-/Fremdrechte (beispielsweise Modus `0700`);
- Datei über `O_NOFOLLOW` geöffnet, keine symbolische Verknüpfung;
- reguläre Datei, genau **32 rohe Binärbytes**, genau ein Hardlink;
- Dateimodus `0400` oder `0600`, gleicher Eigentümer wie Prozess;
- keine API-Key- oder Master-Key-Inhalte in Fehlermeldungen;
- temporärer Buffer wird beim Rücksprung sowie bei Fehlern geleert.

Nicht als garantierte Speicherlöschung missverstehen: JavaScript, OpenSSL,
Betriebssystem und Backups können intern weitere Kopien halten. Der
Callback darf den übergebenen Buffer nicht zurückgeben oder langfristig
referenzieren. Tests verwenden nur kryptographisch zufällige lokale
Fixtures in einem selbst wieder entfernten CI-Verzeichnis.

**Wichtige Betriebsgrenze:** Der geplante Container-Benutzer muss die
Master-Key-Datei lesen dürfen. Docker-Secrets-Bindmounts oder root-eigene
Dateien mit unpassenden Besitzrechten werden absichtlich abgelehnt.
Eine zukünftige Lösung muss diese Berechtigungen im _separat genehmigten_
Deployment sicher festlegen; kein automatisches `chmod`/`chown`, kein
Fallback auf Umgebungsvariablen oder unverschlüsselte Speicherung.

## Rotation und Wiederherstellung

Der aktuelle AES-256-GCM-Envelope verwendet Version 1 und kann nur mit
dem zugehörigen Master-Key entschlüsselt werden. **Nur die Datei
auszutauschen würde alle bereits versiegelten API-Schlüssel unlesbar
machen.** Zukünftige Master-Key-Rotation braucht deshalb eine separat
geprüfte, transaktionale Re-Verschlüsselung mit Versionskennung und
kontrolliertem Rollback oder alternativ die explizite Neueingabe aller
Anbieter-API-Keys. Dieses Paket implementiert bewusst keine Rotation.

Ohne Zugriff auf denselben Master-Key können API-Schlüssel auch aus einem
Datenbankdump nicht wiederhergestellt werden. Der Betreiber hat bewusst
entschieden, **vorerst kein unabhängiges Offsite-Backup** einzurichten.
Dieses Risiko wird dokumentiert, nicht durch CI-Tests aufgehoben.
Bevor echte Keys eingegeben werden, muss entschieden werden, ob nach
einem vollständigen VPS-Verlust alle Anbieter-Keys manuell neu vergeben
werden. Es wird kein Backup ohne Betreiberauftrag eingerichtet.

## CI und Freigabeschranke

`apps/api/src/provider-master-key-file.test.ts` prüft lokal AES-GCM
mithilfe einer nur im Test erzeugten Schlüsseldatei, Dateimodi,
Länge, Eigentum, Verzeichnisrechte, Symlink, Hardlinks, fehlende
Pfadberechtigung und generische Fehler mit Buffer-Löschung.

**Ausdrücklich nicht freigegeben:** produktive Key-Datei, Live-Key-
Eingabeformular, KEK-Generierung auf dem VPS, Aktivierung der Anbieter,
Produktiv-DB-Migrationen oder kostenpflichtige KI-Anfragen. Der neue
Code verändert das bereits laufende VideoNews-Studio-System nicht.
Beszel bleibt das bestehende VPS-Monitoring.
