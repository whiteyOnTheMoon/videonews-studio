# P2-A 0055 – Persönliche Herausgeber- und Ereignisbewertungen

**Stand:** Code und CI-Integration; nicht auf dem VPS aktiviert.

Diese Erweiterung schließt nach Policy-Review 0054 die zwei noch fehlenden
manuellen Dateneingabepfade für das SQL-Ranking 0053:

- **Herausgeber-Provenienz:** Aus einer wirklich freigegebenen Quellen-ID
  und der aktuellen, überprüften Quellenregisterrevision wird
  `source_id / source_revision / publisher_group / quality` festgelegt.
  Eine Quelle darf nicht selbst ihre Qualität oder unabhängige
  Herausgebergruppe liefern. Mehrere Quellen können derselben
  Herausgebergruppe angehören; das Ranking zählt diese dann nur einmal.
- **Ereignisbewertung:** Für `event_id / profile_revision / policy_revision`
  werden die separaten Skalen für Erklärwert, Visualisierbarkeit und
  Risiko persönlich überprüft. Der Faktor ist nicht automatisch
  aus einer Feed-Überschrift oder einem KI-Output zu übernehmen.

Der SQL-Writer ermittelt `reviewer_id` aus der physischen persönlichen
PostgreSQL-Anmeldung (`session_user`), kontrolliert aktive Konten und
`auth_version` und verwirft unbekannte oder deaktivierte Identitäten.
Clients besitzen keine direkten `INSERT`-Rechte in Reviewtabellen.
Alle drei Reviewtabellen aus 0053 bleiben append-only und verhindern
nachträgliche Änderungen und stille Ersatzbewertungen.

Für Provenienz gilt: Die eigene `source_revision` muss die **aktuelle
globale Registerrevision** sein. Ein neu freigegebenes oder gesperrtes
Feedregister entwertet daher ältere Provenienzdaten und verlangt
erneute human review. Bei identischer Registryrevision ist nur eine
unveränderliche Zuordnung pro Quelle zulässig.

Ereignisfaktoren gelten ausschließlich für die aktuelle Policy- und
Profilrevision. Fehlende Policy, fehlender Artikelbezug oder eine aktuell
unfreigegebene Quelle verhindert die Erfassung. Ein vorhandener
Reviewdatensatz kann nicht überschrieben werden; ein neuer
Policyrevisionseintrag macht ein erneutes Review erforderlich.

## Verbindung zum Ranking

Die persönliche Admin-Seite besitzt zwei getrennte Formulare:
Herausgeberzuordnung und Ereignisskalen. API/BFF prüfen auf der
bestehenden persönlichen Authentifizierungsschicht jeweils exakte
Feldlisten, Origin, Zahlenbereiche und Revisionszugehörigkeit.
Ein persönlicher Abschluss des Formulars bedeutet ausdrücklich
**keine Quellennutzungsfreigabe und keine Fakten-/Publikationsfreigabe**.
Der persistierte SQL-Score wird nach einer erneut autorisierten
Projektionsausführung aktualisiert. Ohne eine solche Ausführung
bleibt die gespeicherte alte Berechnung bestehen oder wird durch
bestehende Policyrevision-Schranken ausgeblendet.

## Testumfang

Echtes isoliertes PostgreSQL: zwei synthetische freigegebene Quellen,
getrennter Host-Freigeber, persönlich identifizierter Reviewer,
verschiedene Herausgebergruppen, individuelles Risiko, erneute
Ranking-Berechnung, Wiederholungen, alte Registryrevisionen,
unerlaubte Direkt-Inserts, unregistrierte/deaktivierte DB-Logins
und Rollback beider Migrationszyklen. API/BFF/UI testen
manipulierte Identitäten, Post-Payloads, Abfragen und Origins.

**Unverändert offen:** Konkrete Rechtefreigaben der NASA/JPL-, NOAA-
und USGS-Kandidaten, Live-Feed-Abruf, volle TypeScript/PostgreSQL-
Unicode-Parität, die Installation 0049–0055 auf dem VPS und ein
vollständiger produktiver Nachrichtenabruf mit Admin-Einsicht.
Vorhandene IONOS-Backups und Beszel werden nicht berührt.
