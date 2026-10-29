# P2-A: Ereignisbezogene Risiko-/Visualisierbarkeitsbewertung (Code-only)

**Stand 29.10.2026: Offline-Funktion, kein produktives SQL-Ranking und keine Quelle freigegeben.**

Die vorhandene `assessEditorialCandidate`-Funktion erhält drei zusätzliche
optionale, explizit zu konfigurierende Regeln:

- `visualizabilityWeight` (0–100): Positive, eventbezogene
  Visualisierbarkeit von 0–5.
- `riskWeight` (0–100): Abzug für redaktionelles Risiko von 0–5.
- `maximumRisk` (0–5): Höchstgrenze; darüber wird der Kandidat gesperrt.

`EventEditorialFactors` umfasst `eventId`, `revision`,
`explanatoryValue`, `visualizability` und `risk` (jeweils 0–5).
Die Funktion verwirft fremde Event-IDs, unvollständige und ungültige
Bewertungen. Sind Risiko- oder Visualgewichte größer null und fehlen
Bewertungsfaktoren, wird **kein Score** vergeben.
Publisher-Gruppen bleiben gesonderte Metadaten, kein unabhängiger
Faktenbeleg. Der Score ist auf 0–1000 begrenzt. Dieses reine
Offline-Modell bestätigt weder eine echte Reviewer-Identität noch
Veröffentlichungsrechte oder die Wahrheit eines Claims.

## Noch erforderlich für P2-04 und das Gesamtpaket A

1. Persönlich authentifizierte, revisionsgesicherte Pflege der
   Publisher-Provenienz, Quellenqualität, Risikofaktoren und
   Visual-/Erklärwertfaktoren; diese Eingaben dürfen nicht aus
   Titeln erraten oder von einem Feed selbst behauptet werden.
2. Persistierte gewichtete SQL-Bewertung an dieselben **überprüften**
   Eingaben anschließen und garantierte TS/SQL-NFKC-Parität einschließlich
   Randfällen (Groß-/Kleinschreibung und Unicode-Wortgrenzen) testen.
3. Produktiven Recheck nach Quellenwiderruf und
   Review-/Konfigurationsrevision erzwingen.
4. Noch keine persönlichen NASA/JPL-, NOAA- oder USGS-Freigaben und keine
   produktiven RSS-Tests; die getrennten `feedUrl`/`baseUrl`-Felder
   sind durch PR #358 und Migration 0050 lediglich vorbereitet.
5. Reale Syndikationsbeispiele (identische Agenturmeldung mit
   unterschiedlichen Quelllinks und ggf. abweichender Überschrift)
   sind noch gegen die **persistierte** PostgreSQL-Ereignisprojektion
   zu prüfen. Die bisherige Projektionslogik gruppiert nach
   einem exakten normalisierten Headline-Fingerprint; die konservative
   TypeScript-Ähnlichkeitsgruppierung ersetzt das nicht.

**VPS-Status:** Kein Deploy. IONOS-Backups/Beszel bleiben unverändert.
Keine vorgetäuschte unabhängige Rechteprüfung, KI-Bewertung oder Live-Abnahme.
