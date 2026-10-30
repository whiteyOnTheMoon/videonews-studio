# P2-A 0058 – Exakte Überschriften nur innerhalb von 48 Stunden gruppieren

**Stand:** Reversible Codeänderung und echte isolierte PostgreSQL-Tests.
Kein VPS-Rollout und keine Änderung an Quellenfreigaben.

## Fehlerbild

Die konservative TypeScript-Deduplikation verlangt für **jedes**
bestehende Gruppenmitglied höchstens 48 Stunden Abstand zum neuen
Artikel. Die SQL-Projektion aus 0052 wandte diese Bedingung bisher
nur auf ähnliche, aber nicht exakt fingerprintgleiche Titel an.
Die frühere direkte Suche nach `event_fingerprint` konnte damit eine
neue Nachricht an eine historische Nachricht mit identischem Titel
anhängen, selbst wenn zwischen beiden mehrere Tage lagen.

## Korrektur

Migration 0058 ersetzt nur die bereits registrierte
`vns.project_feed_candidates(text,integer)`-Funktion.

1. Auch bei identischem Artikelfingerprint wird nun geprüft, dass
   **alle** bereits zugeordneten Artikel innerhalb von 48 Stunden
   liegen und eine gültige Veröffentlichungszeit besitzen.
2. Die konservative Prüfung ähnlicher Meldungen verweigert ebenfalls
   künftig jede Zuordnung zu Gruppen mit fehlenden Zeitangaben.
3. Trägt ein älteres Ereignis weiterhin denselben exakten
   Fingerprint, erhält das neue Ereignis einen separat aus
   Originalfingerprint, Quellen-ID und kanonischer Artikel-URL
   abgeleiteten 64-stelligen Hash. Das ist ein
   **Kollisionsausweichschlüssel**, keine neue Faktenbewertung.
4. Der bestehende Artikel-Fingerprint und sämtliche historischen
   Ereignisse bleiben unangetastet. Laufende Quellenauthentifizierung,
   Rechteverwaltung, Scheduler und Ranking-Grenzen bleiben erhalten.
5. Die vorhandene Transaktionssperre serialisiert konkurrierende
   Projektoren. Nachfolgende Nachrichten dürfen sich nur dann einer
   der getrennten Gruppen anschließen, wenn sie deren vollständige
   48-Stunden- und Ähnlichkeitskriterien erfüllen.

## Abnahmetest

Die PostgreSQL-Integrationstests erzeugen zwei getrennt und
synthetisch freigegebene Quellen und eine archivierte Meldung mit
demselben Titel wie eine 71 Stunden jüngere Meldung. Sie prüfen,
dass genau **zwei** Ereignisse entstehen, beide Artikel-Fingerprints
erhalten bleiben und die später eintreffende Meldung der zweiten
Quelle ausschließlich die neue Gruppe ergänzt. Erneutes Projizieren
muss idempotent sein. Nur die aktuelle Gruppe darf als unveröffentlichter
Rankingkandidat bestehen. Migration und Rückmigration werden
in beiden isolierten Datenbankzyklen geprüft.

Die Änderung sichert eine **konkrete** Abweichung zu TypeScript ab.
Sie stellt **keine vollständige Unicode-, Hash- oder globale
Gruppierungsparität** her: Der SQL-Artikelhash verwendet weiterhin
das bisherige Whitespace-/Lowercase-Verfahren, TypeScript zusätzlich
NFKC und Unicode-Wortgrenzen. Diese Unterschiede verlangen gesonderte
Prüfungen vor der produktiven Komplettabnahme.

Offen bleiben der rechtskonforme Bezug tatsächlich genehmigter
Quellen, der kontrollierte VPS-Rollout 0049–0058 und die produktive
Ende-zu-Ende-Prüfung. IONOS-Backups und Beszel werden nicht geändert.
