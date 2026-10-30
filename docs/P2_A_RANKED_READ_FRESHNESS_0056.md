# P2-A 0056 – Gespeicherte Rankingwerte nur bei gültiger aktueller Evidenz anzeigen

**Stand:** Reversible GitHub-Migration; produktiver VPS-Rollout und
tatsächliche Quellenfreigaben sind damit nicht vorweggenommen.

Problem: Ein persistierter Ranglisteneintrag ist eine *Momentaufnahme*.
Nach einer erfolgreichen früheren Berechnung können sich die
Artikel-/Quellzuordnungen einer Ereignisgruppe verändern. Außerdem ist
die tatsächliche Unabhängigkeit von Herausgebern nicht allein aus der
Zahl verschiedener Quellen-IDs abzuleiten. Der bisherige benannte
Admin-Read aus 0053 prüfte zwar aktuelle Policyrevisionen, Risikogrenzen,
Einzelprovenienz, Quellenfreigaben und Artikelalter, nicht aber die
aktuelle **Mindestzahl unterschiedlicher überprüfter Herausgebergruppen**
oder eine seit der Bewertung veränderte Quellen-/Artikelanzahl.

Migration **0056** härtet ausschließlich die persönliche
`vns.named_ranked_feed_page`-Lesefunktion:

- Die gegenwärtige Zahl zugeordneter Artikel muss exakt
  `feed_event_rankings.article_count` entsprechen.
- Die gegenwärtige Anzahl verschiedener Quellschlüssel muss exakt
  `feed_event_rankings.source_count` entsprechen.
- Die Mindestzahl von Quellen des aktuellen redaktionellen Profils
  muss weiterhin erfüllt sein.
- Bei einer gewichteten Ranking-Policy müssen **mindestens so viele
  unterschiedliche, für die aktuelle Quellenregisterrevision geprüfte
  Herausgebergruppen** vorliegen wie die aktuell gebundene Policy verlangt.
- Die bisherigen Prüfungen für aktuelle Policy-Revisionen, Faktor-
  Reviews, Risikogrenzen, Quellenautorisierung und Alter bleiben erhalten.
- **Keine** historischen Rankings, Audit-Einträge, Rezensionen,
  Quellen oder Freigaben werden von dieser Änderung neu geschrieben
  oder gelöscht.

Der reversible Down-Pfad stellt die vormalige Lesefunktion aus 0053
wieder her. Der eingeschränkte persönliche SQL-Zugriff
(`session_user` plus aktive Identitäts- und Authversionsprüfung)
bleibt erhalten. Auch wenn ein Admin einen Kandidaten sieht, ist
`approved_for_publication=false` weiterhin zwingend.

Die isolierten PostgreSQL-Tests erzeugen zwei synthetische,
berechtigt freigegebene Quellen mit separaten Herausgebergruppen,
aktuellem Policy-Review und dokumentierten Ereignisfaktoren.
Sie beweisen die Sichtbarkeit einer korrekten gespeicherten
Momentaufnahme und die sofortige Ausblendung nach
Artikelanzahl-/Quellenanzahl-Abweichungen. Eine neuere Policy mit
mindestens **drei** Herausgebergruppen blendet auch eine künstlich
veraltete, auf zwei Gruppen beruhende Rankingzeile aus.

**Restarbeiten für die produktive P2-A-Abnahme:** zugelassene
NASA/JPL-/NOAA-/USGS-Quellrechte und persönliche Freigaben,
Migrationen 0049–0056 auf dem VPS, getrennte Produktivzugänge,
tatsächlicher Scheduler/Feed-Abruf/Projektor- und Admin-Ende-zu-Ende-Test
sowie vollständige Unicode-Übereinstimmung von TypeScript und SQL.
IONOS-Backups und Beszel bleiben unverändert.
