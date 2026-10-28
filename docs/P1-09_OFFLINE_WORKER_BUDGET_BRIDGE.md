# P1-09 / #230 – Offline Worker-Budgetbrücke

**Status:** Git-only, nicht installiert, nicht aktiviert, keine reale Provider-Anfrage.

Dieses Paket ergänzt die reversible PostgreSQL-Migration **0038** und den
Worker-Vertrag \`provider-budget-worker-bridge.ts\`. Die vorhandene
Preis- und Usage-Prüfung aus #306 und die Reservierungs-/Settlementfunktionen
aus #307 werden dabei verwendet.

Die neue Brücke stellt keinen Netzwerkzugang und keine OpenAI-/Gemini-
Anbindung bereit. \`replayProviderBudgetFixture\` verarbeitet nur eine
**bereits aufgezeichnete** vertrauenswürdige Anbieterantwort aus einem
isolierten Test. Das Modul wird vom produktiven Worker nicht importiert und
muss selbst für Testaufrufe explizit aktiviert werden.

## Schritte im Offline-Vertrag

1. **Reservieren:** Für eine validierte Job-/Request-/Anbieter-/Modell-ID
   fordert der Worker die pessimistische USD-Reservierung an. Die SQL-Policy
   startet deaktiviert und mit Nullgrenzen.
2. **Autoritative Daten lesen:** Eine getrennte SECURITY-DEFINER-Funktion
   gibt die nur serverseitig verwahrten Preis-Snapshot-Daten und Limits für
   exakt diese Reservierungs-ID zurück. Der Worker nimmt keine behaupteten
   Preise aus der Provider-Antwort an.
3. **Beleg prüfen:** Ein zuvor gespeicherter OpenAI-/Gemini-
   Testresponse wird nach #306 streng auf Vollständigkeit, Modell, Tokens,
   Preisversion und reserviertes Maximum geprüft.
4. **Transaktionsabschluss:** Der persistente Nutzungsbeleg aus #302/0036
   und das SQL-Settlement aus #307/0037 laufen innerhalb derselben
   PostgreSQL-Transaktion. Ein Fehler rollt beide Schritte zurück.
   Das Ergebnis \`halted\` wird **committed**, aber niemals als Erfolg
   an den Aufrufer zurückgegeben.
5. **Ausfall/Unklarheit:** Fehlende Usage, ungültige/native
   widersprüchliche Werte, überhöhte Kosten oder defekte Persistenz
   lösen \`halt_provider_live_budget\` aus. SQL speichert den Projektstop
   und eine unveränderliche, personenbezogene Daten nicht enthaltende
   Störfallmarkierung. Eine nicht erreichbare Datenbank bedeutet
   ausschließlich Fehler, niemals Zahlungsfreigabe.

Die Workerrolle besitzt keine direkten Tabellenrechte, und die
SECURITY-DEFINER-Ausführung liegt weiterhin bei einer NOLOGIN-Rolle.
Die Migrationsfolge **0001–0038** wird ausschließlich im isolierten CI
installiert, geprüft, rückgebaut und ein zweites Mal getestet.
Die aktuelle VPS-Datenbank bleibt nach Betreiberprotokoll bei **0018**.

## Grenzen vor dem echten Ausrollen

Die Brücke **ist noch kein Endpoint-Schutz für echte Kosten**. Sie
sendet weder Anfragen noch validiert sie deren Transport-Herkunft.
Für echte Anbieter-Requests muss ein unabhängig geprüfter Dispatcher
folgende zusätzliche, fest gekoppelte Eigenschaften nachweisen:
geprüfte Modell-/Endpoint-Auswahl, wirklich erzwungene Max-Token-Grenzen,
authentifizierter Herkunftsnachweis, verbindliche Preise, sichere
Retry-Identitäten, globale Sperre auch bei Datenbankausfällen und
**EUR-Hardcap einschließlich FX-Puffer** vor jeder Anfrage. Unbekannte
Usage darf nie als kostenlose Nutzung verbucht werden. Ein API-Client
darf die Worker-Sperre nicht umgehen.

Es wurde **kein produktiver DB-LOGIN für Metering angelegt**,
keine Policy aktiviert, kein Secret verwendet, kein VPS-Code geändert
und kein kostenpflichtiger Anbieter aufgerufen. Der maximal 1-EUR-Test
benötigt eine eigene ausdrückliche Freigabe.
