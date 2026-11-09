# P3-C / P3-08 – Offline Credits und Rechtsblocker-Vorschau

**Status:** ausschließlich interner, synthetischer Vorbau für Issue #33.
Dies ist **nicht** die vollständige Abnahme von P3-08 und keine Freigabe
externer Medien. GitHub PR #470 (P3-01) und PR #471 (P3-02) bleiben
technische Voraussetzungen und sind vorerst ohne unabhängigen Review.

## Zweck

`buildOfflineVideoCreditsReport` fasst begrenzte, unbestätigte
Asset-Metadaten für genau ein Video zusammen:

- Vorgeschlagener Credittext, getrennt von tatsächlich bestätigten Credits.
- Lizenztyp, Ursprungs-URL und zwei behauptete Hashes: Medieninhalt und
  archivierte Lizenzbedingungen.
- Abgleich mit einem **vom Aufrufer gelieferten, nicht authentifizierten**
  Download-Beleg (Hashes, Ursprungs-URL, Zeitpunkt).
- Ergebnis der separaten P3-02-Vorprüfung und nachvollziehbare Gründe,
  warum die Nutzung noch gesperrt ist.
- Höchstens 25 Assets, jeweils mit eindeutiger ID und Video-Zuordnung.

Der Begriff `RECORDED_UNVERIFIED` bedeutet ausdrücklich **nur**,
dass der gelieferte Download-Beleg mit den Metadaten übereinstimmt.
Es wurde kein Download durchgeführt. SHA-256-Strings werden in
diesem Schritt nicht gegen echte Dateien nachgerechnet. Weder die
Asset-Quelle noch die rechtmäßige Lizenz wurden unabhängig überprüft.

## Verbindliche Sperre

Jede Rückgabe enthält unveränderlich die Werte:

- `status = BLOCKED`
- `renderAllowed = false`
- `uploadAllowed = false`
- `creditsVerified = false`

Selbst ein CC0-/CC-BY-Asset, das P3-02 zur späteren namentlichen
Prüfung zulässt, kann diese Sperre nicht aufheben. Ein gefälschtes
`publishApproved`-Feld wird ignoriert. Fehlender Beleg, falscher
Hash, unzulässige Lizenz, doppelte Asset-ID oder fremde Video-Zuordnung
werden mit eigenen Fehlergründen sichtbar. Verdächtiger HTML-Credittext
wird nicht als Credits-Vorschlag ausgegeben.

## Abnahmeumfang und spätere Schritte

Der reine TypeScript-Vertrag und die synthetischen Negativtests
werden im vorhandenen CI-Workflow für das Shared-Paket geprüft.
Er ist weder mit PostgreSQL, dem persönlichen Admin noch mit einem
Renderer oder Uploader verbunden. Die SQL-Integrität für Asset-Nutzungen
aus P3-01 wird separat in PR #470 getestet. Ein gemeinsamer
PostgreSQL-zu-Report-E2E ist **noch offen**.

Die Umsetzung ist ein kleiner, ausdrücklich unvollständiger Teil von
P3-08 (#33). Das ursprüngliche Issue verlangt reale Credit-Exports
und Lizenz-Snapshots **je tatsächlich heruntergeladenem Asset** sowie
Sperren direkt an den produktiven Render- und Upload-Einstiegspunkten.
Diese Anforderungen können erst nach den genehmigten Asset-Adaptern,
Rechteprüfungen und der gesonderten Freigabe realer Medien umgesetzt
werden. Issue #33 daher **nicht schließen** und die Statuswerte nicht
als publizierbare Freigabe interpretieren.

Keine zusätzlichen Dienste, keine neuen kostenpflichtigen Medien-APIs,
kein Abruf fremder Medien, kein VPS-Deployment, keine Migration, kein
realer Render, kein Upload und keine Veröffentlichung.
