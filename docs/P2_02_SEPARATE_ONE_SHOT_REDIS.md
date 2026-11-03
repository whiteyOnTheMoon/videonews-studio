# P2-02 – One-shot Feed-Observer: getrennte Redis-Zugänge

Die bestehenden Redis-Benutzer `vns_feed_producer_prod` und
`vns_feed_consumer_prod` besitzen absichtlich verschiedene Berechtigungen
für dieselbe Feed-Queue. Der frühere Observer versuchte dagegen, beide
BullMQ-Rollen mit einem einzigen Redis-Konto auszuführen. Das ist mit den
bereits provisionierten eingeschränkten Redis ACLs nicht vereinbar.

Der **einmalige** Observer und der begrenzte Observer-Scheduler erhalten
jetzt zwei ausschließlich lokal bereitgestellte, jeweils 0400/UID10002
geschützte Secret-Dateien. Der Queue-Produzent meldet sich mit dem
Producer-Konto an. Worker und QueueEvents verwenden ausschließlich das
Consumer-Konto. Unterschiedliche Passwörter und die präzise festgelegten
Login-Namensräume sind Pflicht. Keine neue Redis-ACL und keine weiteren
Redis-Rechte werden benötigt.

Das persistente `feed-consumer`-Profil erhält **keinen** Producer-Secret-
Bind-Mount. Der getrennte `feed-producer` erhält weiterhin nur sein Redis-
Secret, aber niemals PostgreSQL-, Anker- oder Quellenzugriff. Alle Profile
bleiben standardmäßig deaktiviert und haben keine Host-Ports.

Für den späteren, ausdrücklich einzeln autorisierten Bootstrap-Canary
werden folgende bereits vorhandene Hostdateien verwendet:

- `VNS_P2_FEED_PRODUCER_REDIS_PASSWORD_FILE`:
  `/var/lib/videonews-studio/p2-feed-runtime-secrets/vns_feed_producer_redis_password`
- `VNS_P2_FEED_REDIS_PASSWORD_FILE`:
  `/var/lib/videonews-studio/p2-feed-runtime-secrets/vns_feed_consumer_redis_password`

Im Observer-Container werden sie an getrennten Zielen
`/run/secrets/vns_feed_producer_redis_password` und
`/run/secrets/vns_feed_redis_password` eingebunden.
Der Betreiber setzt `VNS_FEED_PRODUCER_REDIS_USER=vns_feed_producer_prod`
und `VNS_FEED_REDIS_USER=vns_feed_consumer_prod`.

Das ist **keine** Freigabe zum Live-Abruf. Erst die aktuell signierte
Quellenrevision, persönlich genehmigte Rechte, bereits installierter
Ein-VPS-Anker, erlaubte Hosts und eine explizite separate Aktivierung
dürfen einen ersten `single_pass` starten. Der erste Checkpoint wird
ausschließlich durch den geprüften Worker erzeugt; keine manuelle
Checkpointdatei und keine Änderung an IONOS-Backups oder Beszel.
