# P1-09: Offizielle Quellen für manuelle Modellpreis- und EUR/USD-Prüfungen

**Status: offline integriert; Admin-Preisfreigabe und KI-Dispatch bleiben
standardmäßig deaktiviert.** Der Besitzer entscheidet über jede
verifizierte Modell-/Preisversion, FX-Obergrenze und deren Aktivierung.

## Warum wir Quellen prüfen

Eine formal gültige HTTPS-Adresse kann auf beliebige oder gefälschte
Preistabellen verweisen. Die persönliche Prüfung darf deshalb nur
Referenzen mit dem _genauen_ offiziell dokumentierten Quellen-Host
annehmen. Der neue, von Web-BFF und API gemeinsam verwendete
`officialPriceReviewSource`-Vertrag ist in
`packages/shared/src/provider-pricing-provenance.ts` definiert.

Er akzeptiert nur die jeweils passende Klasse:

- OpenAI: veröffentlichte Preisübersichten auf `developers.openai.com`,
  `platform.openai.com` beziehungsweise `openai.com/api`
- Google Gemini: `ai.google.dev/gemini-api/docs/pricing`
- Konservativer EUR/USD-Bezug: die EZB-Referenzdokumente unter
  `www.ecb.europa.eu`, `data.ecb.europa.eu` oder die
  EZB-Daten-API-Serie `EXR/D.USD.EUR.SP00.A`

HTTPS alleine reicht nicht. Nicht offizielle Hostnamen, ähnliche Domains,
fremde Provider-Dokumente, Port-Overrides, Benutzerinformationen,
URL-Fragmente oder kodierte Pfadbestandteile werden abgewiesen.
Das System lädt diese Quellen **nicht** automatisch herunter und
legt keinerlei feste KI-Modell-IDs, Preise oder Wechselkurse fest.

## Unabhängige Überprüfung bleibt erforderlich

**Eine passende offizielle URL beweist nicht, dass eingegebene Preise
korrekt oder vollständig sind.** Die jeweiligen Dokumentationen müssen
zum Zeitpunkt der Betreiberprüfung mit der exakt konfigurierten
Modell-ID, Abrechnungsart, Datum, Input-Cache-Verhalten, Kontextlänge
und Outputberechnung verglichen werden.

Offizielle Einstiegspunkte:

- https://developers.openai.com/api/docs/pricing
- https://ai.google.dev/gemini-api/docs/pricing
- https://data.ecb.europa.eu/methodology/exchange-rates

Die veröffentlichten Preise können je nach Anbieter unter anderem von
Standard/Batch/Priority-Verarbeitung, Kontextlängenstaffeln, Tools,
Cache-Schreibvorgängen, zusätzlicher Speichernutzung oder Regionen
abhängen. Das aktuelle P1-09-Textbudget umfasst nur drei reguläre
Token-Raten (Input, gecachter Input und Output) und darf diese
zusätzlichen Kostengattungen **nicht einfach stillschweigend als Null
behandeln**. Nur nachweislich mit dem eingeschränkten Transport
kompatible Preismodelle dürfen jemals freigegeben werden.

Die EZB publiziert Kurse von Fremdwährungen **je Euro**. Ein
konservativer, nach oben gerundeter Betrag in **EUR je USD** erfordert
die korrekte Umkehrung des USD/EUR-Referenzkurses plus einen vom
Betreiber überprüften Sicherheitspuffer; der veröffentlichte
EZB-Referenzwert allein ist weder ein automatisch akzeptierter
Transaktionskurs noch eine Garantie für einen künftigen Wechselkurs.

## Sicherheitsnachweise und Auslieferung

Die API und Web-BFF lehnen inkorrekte Quellen bereits **vor**
persistierenden SQL-Aufrufen ab. Die gemeinsam genutzte reine
Quellenprüfung wird in `@vns/shared` getestet. Die Web-Proxy-Tests
sind Teil des regulären `npm test`-Workflows; bislang fehlten
sie in der festen Web-Testliste.

Die SQL-Admin-Funktionen prüfen weiterhin individuell signierte
Admin-Identität, Ablaufdatum, unveränderliche Datensätze und
Audit-Zuordnung. Die neue Host-Policy ist eine **zusätzliche
HTTP-Vertrauensgrenze**; sie ersetzt weder SQL-Berechtigungsprüfung
noch die Pflicht, den Provider-Writer-Login zu schützen.

Die Admin-Freigabeschalter
`VNS_PROVIDER_PRICE_REVIEW_ENABLED` (API) und
`VNS_WEB_AI_PRICING_REVIEW_ENABLED` (Web) bleiben standardmäßig
**aus**. Das aktuelle aktive VPS-Web/API-Image stammt weiterhin aus
einem älteren Commit, bis ein getrennter, digest-gepinnter
Release und sein Betreiber-Rollout geprüft sind.
Diese Änderung benötigt **keine neue SQL-Migration** über 0043 hinaus.

Ein späterer Produktivtest muss mindestens die Ablehnung fremder
Origins, gültige persönliche Admin-Sitzungen, unzulässige
Referenz-Hosts und den unveränderten Status der Anbieter-/Budgetpolicy
unabhängig prüfen. Keine automatischen Vendor-Anfragen, kein
bezahlter Canary und kein VPS-Rollout werden durch dieses Paket
autorisiert.
