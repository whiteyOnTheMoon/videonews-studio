# P2-03 – Fortschrittsüberwachung des kontinuierlichen Feed-Producers

**Status:** Implementierung und isolierte CI. Keine VPS-Änderung oder
Aktivierung tatsächlicher Feeds.

Bisher wurde der Docker-Status `ready` alle 20 Sekunden erneuert,
auch wenn die asynchrone Redis-Queue-Inspektion oder das Einreihen
eines Jobs noch nicht abgeschlossen war. Der Node.js-Timer und die
Redis-Anfrage können unabhängig voneinander weiterlaufen; ein lebender
Prozess allein belegt deshalb keinen erfolgreichen Fortschritt.

Der neue `feed-producer-progress-guard.ts` erzwingt:

- **Kein `ready` vor dem ersten erfolgreichen Queue-Check.**
- Jede laufende Queue-Inspektion oder Enqueue-Operation darf höchstens
  60 Sekunden benötigen; bei Überschreitung wird unmittelbar
  `stopped` in die bestehende private Health-Datei geschrieben.
- Auch ohne aktive Queue-Operation muss spätestens nach 75 Sekunden
  wieder ein erfolgreicher Queue-Check abgeschlossen sein.
- Die bereits genehmigte 30-Sekunden-Pause zwischen Inspektionen
  bleibt zulässig; Uhrzeitrücksprünge und fehlgeschlagene
  Statusdatei-Schreibvorgänge werden nicht als Gesundheit gewertet.
- Der bestehende getrennte Redis-Producer besitzt weiterhin **keine**
  Datenbank-, Signatur- oder externe Anker-Zugangsdaten. Seine
  15-Minuten-Slots, Backlog- und Enqueue-Failure-Limits ändern sich nicht.
- Der Docker-Healthcheck liest nur die vorhandene private
  `/tmp/vns-feed-producer-health.json` und muss das Redis-Modul
  nicht laden. Ein fehlender, veralteter oder gestoppter Status ist
  ungesund.

Die neuen Tests decken fehlenden Initial-Check, festhängende
Inspektion/Enqueue, normale 30-Sekunden-Pausen, späte Antworten nach
Timeout, Clock-Rollback sowie den tatsächlichen Atom-Heartbeat ab.

**Wichtig:** Ein Docker-Unhealthy-Status erzwingt nicht selbst die
Beendigung einer festhängenden Redis-Promise. Der Abbruch wird
angefordert, und das bestehende `restart: "no"` bleibt bewusst
erhalten. Die produktive Alarmzustellung in Beszel und echte
VPS-Fehlerfälle benötigen weiterhin separate Abnahme.
