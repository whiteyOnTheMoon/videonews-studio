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
- API-, BFF- und Admin-Tests validieren Rollen, Cursor/Limit,
  Feldintegrität, `approvedForPublication=false` und verweigerte
  Schreibmethoden. Bestehende P2-Integrations-Checks testen
  Feed-Polling, Queue, Datenbank und Projektor getrennt.
