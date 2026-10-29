# P2-A 0053 – gewichtet persistiertes Ranking mit getrennten Review-Eingaben

**Stand:** SQL-/CI-Fundament, standardmäßig ohne geprüfte Gewichtspolitik.
**Keine Live-Freigabe, kein VPS-Rollout.**

## Umsetzung

Migration `0053_reviewed_weighted_rankings` ergänzt drei außerhalb der
Feed-/API-/Projektor-Schreibrechte gehaltene, append-only Reviewregister:

1. `feed_ranking_policy_reviews`: Profilrevision, Revisionsnummer, sechs
   Bewertungsgewichte, Mindestzahl verschiedener Publisher-Gruppen und
   Risikogrenze.
2. `feed_publisher_provenance_reviews`: Quellen-ID **und aktuelle
   Quellenregisterrevision**, Herausgebergruppe, geprüfte Qualitätsstufe.
3. `feed_event_factor_reviews`: Event-/Profil-/Policyrevision und die
   gesondert beurteilten Faktoren Erklärwert, Visualisierbarkeit und Risiko.

Die Reviewtabellen sind **nicht** durch Publisher, Feed-Worker,
Consumer, Projektor-LOGIN oder allgemeine Editor-/API-Rollen
beschreibbar. Es gibt bewusst noch kein unautorisierbares
`feedUrl`-Feld, das automatisch Eigentümer oder Qualität bezeugt.
Der nachfolgende echte DB-Rollout benötigt ein ausdrücklich zugelassenes,
personengebundenes Reviewverfahren; die gegenwärtigen Einträge können
nur von autorisierter DBA-Verwaltung erstellt werden. Eingetragene UUIDs
allein sind keine beglaubigte Unabhängigkeit.

Der bestehende geschützte Projektionsaufruf berechnet einen Score
zwischen 0 und 1000 aus:

- Keyword-Treffern und `relevance_weight`;
- zeitlicher Nähe und `freshness_weight`;
- dem Durchschnitt explizit geprüfter Quellenqualität und
  `quality_weight`;
- eigens begutachtetem Erklärwert und `explanatory_weight`;
- begutachteter Visualisierbarkeit und `visualizability_weight`;
- Risikoabzug und `risk_weight`, mit harter `maximum_risk`-Grenze.

Verschiedene Quellen-IDs reichen für
`minimum_publisher_groups` ausdrücklich **nicht** aus.
Beide Datenquellen müssen zur aktuellen Quellen- und Profilrevision
passen. Wenn noch **kein** Reviewprofil existiert, bleibt das
bisherige, ausdrücklich als ungewichtet gekennzeichnete
Metadatenranking nutzbar. Ist ein Gewichtungsreview vorhanden,
fehlen aber überprüfte Publisher- oder Ereignisfaktoren, erfolgt
**keine** neue gewichtete Speicherung. Die persönlich
authentifizierte Admin-Leseabfrage blendet überholte
Policyrevisionen sofort aus. Jede Bewertung bleibt
`approved_for_publication=false` und benötigt unabhängige
Claimprüfung.

## Was noch offen ist

- Versionierte, persönlich authentifizierte und unabhängig
  bestätigte Review-CRUD-Funktionen im Admin-Tool für die drei
  Reviewtabellen; insbesondere darf die bloße Reporter-UUID
  nicht als Ausweis eines Prüfers gelten.
- Ein vollständig geprüfter Profil-Policy-Vertrag zwischen Admin,
  TypeScript und PostgreSQL einschließlich mehrsprachiger
  Unicode-/Locale-Parität, nicht nur der NFKC-CI-Fälle.
- Echte source-/hostbezogene Rechtefreigaben sowie Live-Abruf
  der drei offiziellen NASA/JPL-/NOAA-/USGS-Feeds.
- Beweis eines echten, auf dem VPS gespeicherten und dem persönlich
  eingeloggten Admin angezeigten Kandidaten.
- Sichere, getrennte SQL- und Secret-Custody, Rollout-/Rollback-
  Vorbereitungen und VPS-Acceptance. Bestehende IONOS-Backups
  und Beszel bleiben unberührt.

In isolierter PostgreSQL-CI werden normale und gewichtete Kandidaten,
zwei getrennte Herausgebergruppen, eine konkrete
Visual-/Erklär-/Risikobewertung, die Schutzgrenzen,
append-only Verweigerung und Policy-Revisionswiderruf geprüft.
