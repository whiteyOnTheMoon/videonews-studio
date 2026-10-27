# P1-09 / #230 — Native Usage & Preisprüfung

**Status: offline, nicht ausgerollt.** Die Module besitzen keinen
Provider-Client, keine Schlüssel, kein Netzwerk und keine aktive
Worker-Einbindung. Sie autorisieren keine kostenpflichtigen Aufrufe.

## Native Anbieternachweise

**OpenAI Responses:** Die Auswertung verlangt eine abgeschlossene Antwort
mit identischer Modell-ID, Response-ID, belegten Input-/Output-/Gesamt-Tokens,
expliziten Cache-Tokens und konsistenter Reasoning-Teilmenge.

**Google Gemini generateContent:** Die Auswertung verlangt passende
Modellversion und Response-ID, abgeschlossene Kandidaten und widerspruchsfreie
Token-Zahlen. Gemini-Prompt-Tokens umfassen den Cache; Thinking-Tokens werden
zusammen mit Kandidaten-Tokens als Output gezählt.

Nicht unterstützte Tools, Nicht-Text-Modalitäten, unvollständige Antworten,
widersprüchliche Zahlen und nicht abgeschlossene Kandidaten werden abgewiesen.
Ein solcher Fehler ist **keine Nullkostenabrechnung**. Die bestehende
Reservierung muss bis zur Prüfung gesperrt bleiben.

Die Parser geben keine Prompts, Antworten oder Zugangsdaten zurück.
Jeder Beleg bleibt \`persistent: false\` und \`approvedForPayment: false\`.

## Verifizierte Feldreferenzen (27.10.2026)

- [OpenAI Responses Usage](https://platform.openai.com/docs/assistants/migration)
- [Gemini GenerateContent UsageMetadata](https://ai.google.dev/api/generate-content)

Provider-Usage ist keine Rechnung. SKU, Cache, Modalität, Tier, Fehler,
abgebrochene Aufrufe und nachträgliche Rechnungsdaten können zusätzliche
Kosten bedeuten. Ein genauer Abgleich mit der Abrechnung bleibt notwendig.

## Preisprüfung ohne Freigabe

\`apps/worker/src/provider-priced-usage.ts\` verlangt einen unabhängigen,
serverseitig geprüften Preis-Snapshot für das exakte Modell und eine bereits
bestehende Reservierung. Ohne beides wird kein Kostenbeleg erstellt.

Die Rechnung arbeitet ausschließlich mit \`BigInt\` und ganzzahligen
Mikro-US-Dollar je Million Tokens. Uncached Input, Cached Input und Output
werden separat bewertet und nur einmal am Ende aufgerundet.

Übersteigt der rechnerische Betrag die Reservierung, wird der Beleg
abgewiesen. Die Reservierung muss dann erhalten bleiben. Die Tests
verwenden erfundene Zahlen, **keine bestätigten Anbieterpreise**.

## Fehlende Produktivanforderungen

- Geprüfter, zeitlich versionierter realer Preis-/Modellkatalog.
- Atomare PostgreSQL-Reservierung und -Abrechnung für Job/Tag/Monat.
- Idempotente, getrennt authentifizierte Echtanbieter-Integration.
- Erfassung von Fehlern, verspäteter Usage und Nicht-Text-Einheiten.
- Vendor-Rechnungsabgleich und unabhängige Freigabe des Canary-Laufs.
- Globale Sperre bei unklaren Kosten, Ausfällen und Budgetüberschreitungen.

Migration \`0036\` ist noch nicht auf dem VPS installiert. Die bestätigten
Migrationen enden bei \`0018\`; \`0036\` darf nicht isoliert installiert werden.
Der Betreiber hat höchstens 1 EUR für einen späteren, eigens genehmigten
Canary erlaubt. Diese Änderung löst keinen echten Anbieteraufruf aus.
