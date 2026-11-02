# P2-02 – Dateieigentum und Zugriffsgrenzen für Feed-Laufzeit-Secrets

**Status:** GitHub-Code und isolierte CI. Kein Zugriff auf den VPS, keine
Aktivierung von Quellen, keine neuen Schlüssel oder Zugangsdaten.

## Bisherige Lücke

Die persönliche Datenbank- und unabhängige Ankerfreigabe war streng
geprüft. Die Einmalbeobachtung und der dauerhafte Worker öffneten
ihre Feed-/Redis-/Anker-Passwörter jedoch noch direkt per
`readFileSync(path)`. Dadurch wurden Symlinks und unerwartete
Dateirechte an dieser Grenze nicht ausdrücklich abgewiesen.
Die Ed25519- und TLS-CA-Dateien verlangten zwar einen regulären Inode,
aber nicht dessen dokumentierten Eigentümer und die exakten Rechte.

## Einheitlicher, fail-closed Vertrag

Die neue gemeinsame Funktion liest die **bereits vorhandenen**
Betreiberdateien ausschließlich mit `O_NOFOLLOW` und einem bereits
geöffneten Dateideskriptor. Sie prüft Eigentümer, Modus, Einzel-Link,
Größe, den kanonischen Pfad sowie unveränderte Inode-Metadaten vor und
nach dem Lesen. Fehlermeldungen enthalten keine Pfade oder Inhalte.

- Feed-Datenbank-, Redis- und unabhängiges Anker-Passwort: regulärer
  Inode, Eigentümer **UID 10002**, Modus **0400**. Da der Modus keinen
  Gruppenzugriff erlaubt, muss die bestehende Datei dafür nicht in
  eine andere GID verschoben werden.
- Gepinnter Ed25519-Public-Key und unabhängige TLS-CA: regulärer Inode,
  Eigentümer **UID 0**, Gruppe **10002**, Modus **0440**.
- Der einlesende Prozess selbst muss **UID/GID 10002** sein.
- Anonyme, gruppen- oder weltlesbare Secrets, Symlinks, zusätzliche
  Hardlinks, unerwartete Dateieigentümer sowie unzulässige Inhalte
  werden abgewiesen.
- Die Einmalbeobachtung und der dauerhafte Feed-Consumer/-Producer
  verwenden denselben Code. Die getrennten Rollen, gesetzten
  Zugangsdatenpfade und die bestehenden Berechtigungsprüfungen bleiben
  verpflichtend.

## CI und produktive Grenze

Der isolierte Test erzeugt ausschließlich synthetische Dateien und
wechselt im Unterprozess tatsächlich auf UID/GID 10002. Positive
Zugriffstests und negative Prüfungen von Eigentümern, Modi,
Symlinks, Hardlinks und ungültigen Secret-Inhalten laufen ohne
Produktivverbindungen.

Die vorhandenen fünf Feed-Laufzeit-Secrets auf dem VPS werden
**nicht** ausgetauscht oder gelesen. Der Betreiber muss vor einem
künftigen Rollout rein lesend prüfen, ob die vorhandenen Mounts den
hier beschriebenen Rechtevertrag erfüllen. Ein erfolgreicher Test
ist weder Lizenznachweis noch Freigabe des produktiven Feedstarts.
