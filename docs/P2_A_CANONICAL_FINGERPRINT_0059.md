# P2-A 0059 – Kanonische Titel-Fingerprints, Legacy-Kompatibilität und eindeutige Ereigniszuordnung

**Stand:** Reversible PostgreSQL-Migration mit isolierter CI-Abnahme; kein
produktiver Rollout und keine tatsächliche Quellenfreigabe.

## Abweichung

TypeScript erstellt Titel-Fingerprints aus kleingeschriebenen,
NFKC-normalisierten Unicode-Wörtern ohne Satzzeichen. Die SQL-Projektion
aus 0058 berechnete den SHA-256-Wert dagegen aus kleingeschriebenem
Originaltext, in dem nur Whitespace vereinheitlicht war. Daher konnten
gleiche Titel mit anderer Zeichensetzung oder Fullwidth-Zeichen
verschiedene Hashes erhalten. Außerdem bevorzugte SQL bisher exakte
Fingerprint-Treffer, selbst wenn eine andere Ereignisgruppe ebenfalls
alle Ähnlichkeitskriterien erfüllte; der TypeScript-Clusterer legt
bei Mehrdeutigkeit eine eigene Kandidatengruppe an.

## Implementierung

Migration **0059** ersetzt ausschließlich die
`vns.project_feed_candidates(text,integer)`-Funktion:

- Neue Artikel erhalten den SHA-256-Hash der bereits im Ranking
  verwendeten NFKC-Wortnormalisierung
  `vns.rank_nfkc_words(headline)`. Dies gleicht die nachgewiesenen
  Zeichensetzungs-, NFKC- und kurzen Titelbeispiele an.
- Historische Artikel und ihre bestehenden
  `headline_sha256`-Werte bleiben **unverändert**. Beim erneuten
  Bearbeiten einer noch nicht zugeordneten identischen kanonischen URL
  akzeptiert die Projektionsfunktion den neuen oder den historischen
  Digest **nur bei identischer Originalüberschrift, Quelle und
  Veröffentlichungszeit**.
- Die Gruppierung verwendet für alle bisher zugeordneten Artikel
  dieselbe Bedingung: maximal 48 Stunden Zeitabstand **und**
  entweder identische normalisierte Wörter oder mindestens 80 Prozent
  Jaccard-Ähnlichkeit mit sechs unterschiedlichen längeren Wörtern.
- Nur **genau eine** zulässige Ereignisgruppe darf übernommen werden.
  Wenn zwei Gruppen passen, wird ein neuer, weiterhin unveröffentlichter
  Kandidat angelegt. Der kollisionsfreie separate Ereignis-Digest aus
  0058 bleibt bestehen.

Der produktive Projektor läuft weiter ausschließlich hinter den
bestehenden Quelle-/Host- und URL-Freigabeschranken. Es werden weder
Rechte erweitert noch Freigaben oder alte Rankings umgeschrieben.

## Verifikation

Die echten PostgreSQL-Tests mit synthetischen Freigaben prüfen:

1. Bekannte SHA-256-Vektoren für Fullwidth-Unicode und Satzzeichen,
   identisch zu den entsprechenden TypeScript-Operationen.
2. Die Zuordnung neuer Schreibweisen zu einem vor 0059 angelegten,
   nicht veränderten historischen Artikel innerhalb von 48 Stunden.
3. Die Zusammenführung von Fullwidth-/ASCII-Varianten sowie kurzen
   Titeln, für die keine sechs Ähnlichkeitstokens existieren.
4. Die Aufspaltung identischer Titel bei Zeitabstand größer
   als 48 Stunden; ein drittes Ereignis in der zeitlichen Mitte darf
   nicht willkürlich einem von zwei passenden alten Ereignissen
   zugeordnet werden.
5. Idempotentes erneutes Projizieren, unveröffentlichte
   SQL-Rankingkandidaten und zwei vollständige Migrations-/Rollbackzyklen.

## Verbleibende Grenzen

Dies ist **keine universelle, bytegenaue Unicode-Parität**. TypeScript
verwendet ICU-`toLocaleLowerCase("en")` und Unicode-Property-Escapes,
PostgreSQL weiterhin `lower(normalize(..., NFKC))` sowie
`[[:alnum:]]`. Unicode-Version, Cluster-Collation und die Reihenfolge
der Case-/Kompatibilitätsnormalisierung können Unterschiede erzeugen.
Auch TypeScript-Ereignis-IDs basieren auf SHA-256 und sind nicht dasselbe
wie die produktiven, UUID-basierten PostgreSQL-Ereignis-IDs. Ein
produktiver PostgreSQL-Preflight bleibt notwendig.

Weitere P2-A-Abnahmepunkte: dokumentierte Nutzungsrechte und persönliche
Freigaben echter Feeds, Rollout der Migrationen 0049–0059,
tatsächliche Abrufe sowie Scheduler- bis Admin-Ende-zu-Ende-Prüfung.
IONOS-Backups und Beszel bleiben unverändert.
