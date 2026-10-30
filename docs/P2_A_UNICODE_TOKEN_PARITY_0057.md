# P2-A 0057: Unicode-Tokengrenzen der Kandidaten-Deduplikation

**Status:** Code und isolierte Tests; kein VPS-Rollout.

Die TypeScript-Funktion `groupConservativeEventCandidates` verwendet
für die lexikalische Ähnlichkeit Mengen aus NFKC-normalisierten,
kleingeschriebenen Worttokens mit mindestens zwei Unicode-Codepoints.
Die bisherige PostgreSQL-Funktion `vns.rank_headlines_overlap`
verwendete zwar dieselbe Mengen- und Jaccard-Schwelle, zählte aber auch
isolierte einzelne Buchstaben und Ziffern. Das konnte zwei ansonsten
gleiche Meldungen mit unterschiedlichen kleinen Zusätzen auseinanderhalten.

Migration 0057 korrigiert die beiden SQL-Tokenmengen auf
`char_length(word) >= 2`, entsprechend dem TypeScript-Muster
`[\\p{L}\\p{N}]{2,}`. Mindestens sechs gemeinsame unterschiedliche
Tokens sowie mindestens 80 Prozent Jaccard-Übereinstimmung bleiben
notwendig. Es handelt sich um ein konservatives Kandidaten-Clustering,
nicht um einen Beweis gleicher Nachrichteninhalte.

Die Migration ersetzt nur die PostgreSQL-Funktion. Bereits angelegte
Ereignisse, Artikel, Ranking-Snapshots, persönlich zugeordnete Reviews
und Quellenfreigaben bleiben unverändert. Das Down-Skript stellt die
vorherige Funktionsdefinition wieder her.

Die isolierten SQL- und TypeScript-Tests überprüfen dieselben positiven
und negativen Beispieltitel: unterschiedliche Einzelbuchstaben,
NFKC-Fullwidth-Schrift, wiederholte Wörter, andere inhaltstragende
Wörter und weniger als sechs unterschiedliche größere Tokens.
Weitere SQL-Tests prüfen grundlegende Unicode-Normalisierung und
bestehende EXECUTE-Beschränkungen.

## Präzise verbleibende Grenze

**Vollständige Unicode- oder Ereignisidentitäts-Parität ist damit noch
nicht nachgewiesen.** Insbesondere hängen Unicode-Kleinbuchstabenbildung
und Zeichenklassen auf PostgreSQL-Seite von Cluster-/Collation-Einstellungen
ab. TypeScript verwendet ICU-`toLocaleLowerCase("en")`; SQL verwendet
`lower(normalize(..., NFKC))` und POSIX-`[:alnum:]`. Auch die
Fingerprint- und Clustering-Reihenfolge beider Implementierungen sind
nicht generell identisch. Der kontrollierte VPS-Rollout braucht daher
einen geprüften Unicode-/Collation-Preflight und einen End-to-End-Test.

Die bekannten separaten Arbeiten für Paket A bleiben: Nutzungsrechte
echter Quellen, persönliche Quellen- und Hostfreigaben, getrennte
Zugangsdaten, Rollout der Migrationen 0049–0057 und echte Abrufe.
IONOS-Backups und Beszel sind nicht Gegenstand dieser Änderung.
