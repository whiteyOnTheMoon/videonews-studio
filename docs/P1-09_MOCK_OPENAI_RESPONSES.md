# P1-09 — Simulierte OpenAI-Antworten (nur CI, keine Verbindung)

**Stand 25.10.2026:** OpenAI wurde als erster Textanbieter für englischsprachige
VideoNews-Studio-Skripte ausgewählt. Gemini bleibt Kandidat für englisches TTS.
Die tatsächliche Verarbeitung echter Provider-Anfragen ist **nicht aktiviert**.

## Reiner Offline-Adapter

`apps/worker/src/mock-openai-response.ts` enthält die reine Funktion
`evaluateMockOpenAiResponse(input, simulatedResponse)`. Sie nimmt ausschließlich
manuell übergebene synthetische Daten entgegen. Es gibt keine Netzwerk-,
Datei-, Env-, Secret-, API-SDK-, PostgreSQL-, Redis- oder Docker-Anbindung.
Der aktive Probe-Worker sowie der inaktive Research-Worker importieren die
Funktion nicht.

Die Eingabe enthält ausschließlich `jobId`, `requestId`, `stage`, `model`,
`language`, `maxInputTokens` und `maxOutputTokens`; Prompts, URLs, Tokens
und andere Zusatzfelder werden verweigert. Der gültige Plan wird durch
`proposeOfflineTextReservation()` aus der englischen Anbieterpolitik geprüft.

Die Antwort ist eine **Responses-API-ähnliche Testhülle** aus `id`, `object`,
`status`, `model`, `output` und `usage`:

- `object=response`, `status=completed`, exakt zum Plan passendes Modell
- Genau eine Assistant-Nachricht mit genau einem `output_text`-Segment
- Nur begrenzte, nichtleere synthetische englische Textbeispiele
- Nur ganzzahlige `input_tokens`, `output_tokens`, `total_tokens`; Summe und
  genehmigungsfreien Offline-Reservierungsrahmen müssen übereinstimmen
- Kein Tool-Aufruf, keine externe Suche, kein Refusal, keine unvollständige,
  zusätzliche oder multimodale Ausgabe; solche Fälle werden abgelehnt

Das ist **kein vollständiger Parser einer echten OpenAI-Responses-API-Antwort**.
Echte Antworten können weitere Felder, reasoning/cached tokens, Tools,
mehrere Ausgabeelemente sowie Teilabbrüche enthalten. Später muss der
Netzwerkadapter diese Varianten separat behandeln und abrechenbaren Verbrauch
gegen echte Anbieterbelege und aktuelle Preise prüfen. Die Dokumentation der
API-Semantik befindet sich unter:
https://platform.openai.com/docs/api-reference/responses/object

Ergebnis einer erfolgreichen synthetischen Prüfung:

- `syntheticUsage`: exakt die acht Pflichtfelder des vorhandenen
  `validateSyntheticUsage()`-Modells, kompatibel mit der **synthetischen**
  PostgreSQL-Belegfunktion, aber ohne Datenbankschreibzugriff
- `estimatedCostMicroUsd`: BigInt-basierte Kostenschätzung über die
  datierte, nicht freigegebene Preisdefinition pro geplantem Modell
- `simulated:true`, `estimated:true`, `requiresEditorialReview:true`
- `approvedForPublication:false`, `networkAllowed:false`,
  `spendApproved:false`

Wiederholte identische Tests erzeugen identische Werte, werden **nicht**
persistiert und sind **kein echter persistenter Duplikatschutz**.
Erst der gesondert freizugebende DB-Ledger kann diese Rolle erfüllen.
Ebenso sind Mustertexte weder verifiziert noch zur Veröffentlichung geeignet.

## Abnahmegrenzen und nächste Schritte

`apps/worker/src/mock-openai-response.test.ts` prüft englische Stufen,
Modellzwang, Kostenberechnung, synthetische Belegform, Ablehnung zusätzlicher
Schlüsselfelder, fehlende / widersprüchliche Tokens, ungültige
Antwortstatus und Mehrfachausgaben. Tests verwenden ausschließlich lokale
Fixtures. Es werden keine API-Schlüssel oder echte Anbieteraufrufe benötigt.

Diese Erweiterung darf weder mit der realen OpenAI-API noch mit einer
produktiven Datenbank oder einem Veröffentlichungsprozess verbunden werden,
bevor die separate Berechtigung, authentifizierte Zugriffe, aktuelle Preise,
atomare Job-Budgetreservierung, idempotente Provider-Anfragen,
Timeout-/Retry-Regeln und Quellen-/Freigabeprüfung genehmigt und getestet sind.

**Keine** Änderungen an laufenden VPS-Diensten, Beszel oder Backups.
Issue #9 bleibt offen; Backups wurden bewusst durch den Betreiber vertagt.
