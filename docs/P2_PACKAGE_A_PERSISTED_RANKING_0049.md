# P2-Paket A: freigegebener Feed → persistierte Rankingkandidaten → Admin

**Stand: Code-Integration, produktive Aktivierung weiterhin gesperrt.**

## Durchgängiger Integrationspfad

1. Quellenfreigaben inklusive aktueller Host-Autorisierung sind bereits in
   `vns.admin_source_registry`, `vns.admin_source_host_approvals` und der
   Signatur-/Laufzeitprüfung enthalten.
2. Der vorhandene getrennte Scheduler/Consumer führt signierte, genehmigte
   Feed-Polls aus. `vns.commit_feed_poll` persistiert die kandidatenfähigen
   Rohmetadaten mit Lease- und Dublettenprüfung.
3. Der getrennte `feed-project-once` führt ausschließlich
   `vns.project_approved_feed_candidates` aus. Migration **0049** erweitert
   diesen bestehenden Projektionsaufruf atomar: Nach der bisherigen
   Artikel-/Event-Projektion wird **in derselben Transaktion**
   `vns.refresh_approved_feed_rankings` gestartet. Schlägt der Ranker fehl,
   darf die Projektion nicht erfolgreich committen.
4. Die neue Tabelle `vns.feed_event_rankings` hält Ranking-Snapshots mit
   Event-UUID, Profilkennung und -revision, Score (0–1000), Artikel-/Quellen-ID-
   Zählung, begrenzten Gründen und Zeitpunkt. Bei Wiederholung werden
   Kandidaten derselben Profilrevision deterministisch aktualisiert, ohne
   doppelte Zeilen. Gegenüber dem Produkt sind es nur **Metadaten-Kandidaten**,
   ohne unabhängige Bestätigung oder Veröffentlichung.
5. Die SQL-Rankingfunktion vergleicht aktuelle Profildaten mit
   Artikelüberschriften, Schlagwörtern, Sperrlisten, Mindest-Quellen-IDs und
   Altersgrenzen. Jedes im Event enthaltene Quellen-ID muss weiterhin aktuell
   durch das freigegebene Register und die Host-Autorität bestätigt sein.
   Die SQL-Texterkennung ist eine konservative normalisierte
   `[:alnum:]`-Wort-/Wortgruppenprüfung; sie ist **noch nicht** semantisch
   gleichwertig zum Unicode-NFKC-Ranking des TypeScript-Offline-Moduls,
   insbesondere nicht in allen Sprachen. Die neue Datenbankwertung verwendet
   auch noch nicht die komplette gewichtete Herausgeber-/Risiko-Logik.
6. Die persönlich authentifizierte Admin-API
   `GET /admin/editorial-ranked-events?limit=25` liest nur über
   `vns.named_ranked_feed_page`. Die PostgreSQL-Funktion prüft
   `session_user` gegen den aktuellen persönlichen DB-Eintrag und zeigt
   ausschließlich die aktuelle Profilrevision sowie Kandidaten mit
   aktuell als genehmigt verzeichneten Quellen. Keine normalen Worker-,
   Feed-Poll- oder API-Pool-Logins erhalten direkten SELECT.
7. Die vorhandene Next.js-Admin-Sitzung und der Editor-Cookie schützen
   `GET /api/admin/editorial-ranked-events?limit=25`. Die neue
   Admin-Kandidatenliste zeigt Score, Quellen-IDs, Artikelanzahl,
   Profilrevision, Gründe und Rankingzeitpunkt. Alle Rückgabefelder werden
   vor der Anzeige auf strikte Typen, Grenzen und
   `approvedForPublication=false` geprüft.

## Separat freigebbarer kontinuierlicher Projektor

Der zusätzliche Worker `apps/worker/src/feed-project-continuous.ts`
übernimmt die periodische Anbindung von **drei bis fünf** explizit
benannten Quellen an den bereits vorhandenen, persönlich getrennten
Projektions-DB-Login. Sein Docker-Profil `feed-project-continuous`
ist standardmäßig aus; es montiert ausschließlich das dedizierte
Projektor-Passwort, hat keinen Host-Port, keinen Redis-Login, keine
Signer-/Feed-Screts und kein öffentliches Netz. Alle Quellen werden
bei jedem Lauf **erneut** durch den bestehenden `projectApprovedSource`
identitäts- und SQL-seitig geprüft. Nach Migration 0049 aktualisiert
dieser eine Aufruf zugleich die dauerhaft gespeicherten Rankings.

Erst eine ausdrückliche separate Freigabe mit folgenden Werten
ermöglicht die Aktivierung: `VNS_P2_FEED_PROJECTION_ENABLED=true`,
`VNS_P2_FEED_PROJECTION_OPERATOR_ACK=true`,
`VNS_P2_FEED_PROJECTION_CONTINUOUS_ENABLED=true`,
`VNS_P2_FEED_PROJECTION_CONTINUOUS_OPERATOR_ACK=true`;
`VNS_P2_FEED_PROJECTION_SOURCE_IDS` muss 3–5 verschiedene
zulässige IDs enthalten, mit `VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES`
in {15,30,45,60}; der bestehende streng eingeschränkte
`VNS_P2_FEED_PROJECTION_DB_USER`, das Passwortfile und ein Limit
von 1–100 sind weiterhin vorgeschrieben. Der Modus ist fest
`continuous`; ein Bootstrap unbekannter Quellen ist verboten.

Der Prozess arbeitet nacheinander; **ein Fehler beendet den gesamten
Prozess ohne Auto-Retry**, worauf der Betreiber die Ursache/fehlgeschlagene
Quelle prüfen und anschließend kontrolliert neu starten muss.
Während des Intervalls sind keine DB-Verbindungen geöffnet. Ein
gleichzeitiger One-shot-Lauf mit derselben Quelle ist betrieblich zu
vermeiden; SQL-Transaktionen, Unique Keys und gespeicherte Profile
sind gegen Wiederholungen abgesichert.

Damit besteht eine vorbereitete **automatische Verbindung zwischen
bestätigtem Feed-Commit, geschützter Projektion, persistiertem Ranking
und Admin-Lesepfad**. Ohne erfolgreich bestätigte reale Quellrechte,
Secrets, Monitoring des Dienstes und kontrollierten VPS-Start handelt
es sich weiterhin um überprüften Code, nicht um einen Live-Nachweis.

## Sicherheits- und Abnahmegrenzen

- Neue Migration und Code sind **nicht** auf dem VPS ausgerollt. Das
  bestehenden Profil für `feed-project-once` sowie alle anderen Feed-
  Dienste bleiben standardmäßig deaktiviert. Keine Freigabeschalter,
  Anmeldedaten, Schlüssel oder API-Provider wurden automatisch angelegt.
- Kein Betreibervortrag zu IONOS-Backups oder Beszel ist erneut erforderlich.
  Der produktive Restore-/Alarmtest des neuen Feed-Services bleibt eine
  separate, konkrete Rolloutprüfung.
- Die obige Rankingliste ist **kein** Freigabestatus. Ein älteres
  Ranking bleibt ein historischer Snapshot und kann trotz unveränderter
  Profilrevision bereits veraltet sein. Aktuelle Quellenfreigaben, Lizenzen,
  Freshness und neue Fakten müssen vor jeder redaktionellen Freigabe
  unabhängig geprüft werden.
- Zum vollständigen Abschluss von Paket A fehlen noch produktiv nachgewiesene
  3–5 tatsächlich erlaubte Quellen, der kontrolliert aktivierte
  kontinuierliche Producer/Consumer-/Projektionsbetrieb, ein
  einheitlicher persistierter **gewichteter** Rankingalgorithmus,
  die betriebliche Fehler-/Replay-Abnahme sowie die bestätigte
  Admin-Anzeige auf dem VPS. Die Migration ist zunächst nur für den
  kontrollierten Rollout vorbereitet; aus CI folgt kein Live-GO.

## Tests

- `db/tests/0049_approved_feed_rankings.test.sql` nutzt echte,
  isolierte PostgreSQL-Tabellen, genehmigt eine synthetische Quelle
  einschließlich unabhängiger Host-Freigabe, persistiert zwei Artikel
  in einem Event, aktualisiert den Ranking-Snapshot und lehnt eine
  gesperrte Profilkonfiguration sowie einen nachträglichen
  Quellenwiderruf ab.
- Die reversible Migration wird in beiden Zyklen des bestehenden
  GitHub-Actions-Tests `db/scripts/test_migrations.sh` geprüft.
- Die erweiterte **echte Redis-/PostgreSQL-Integrationsprüfung**
  `scripts/ci_p2_integrated_ports.mjs` führt nun drei signierte,
  synthetische Feed-Quellen über BullMQ und den realen PostgreSQL-Poll-
  Commit. Anschließend führt sie einen vollständigen Durchlauf des
  kontinuierlichen Projektors unter dem **dedizierten PostgreSQL-LOGIN**
  aus. Die Prüfung erwartet genau ein persistiertes Event-Ranking über
  drei Quellen-IDs, liest es mit einem anderen **persönlich authentifizierten
  PostgreSQL-LOGIN** per `vns.named_ranked_feed_page` und bestätigt,
  dass Wiederholungen keine doppelten Ergebnisse erzeugen.
  HTTPS-Anfragen verwenden ausschließlich lokale Fixtures; die
  GitHub-Actions-Datenbank und Redis sind wegwerfbar.
- API-, BFF- und Admin-Tests validieren Rollen, Cursor/Limit,
  Feldintegrität, `approvedForPublication=false` und verweigerte
  Schreibmethoden. Bestehende P2-Integrations-Checks testen
  Feed-Polling, Queue, Datenbank und Projektor getrennt.
