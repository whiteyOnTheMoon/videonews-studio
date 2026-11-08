# P2-04 – Isolierter Admin-Ranking-Abruf über die echte API

Der bisherige P2-Ende-zu-Ende-Test belegte bereits:
signierte synthetische Quellen -> Queue -> persistierte Artikel ->
Ereignisprojektion -> Ranking -> persönlich berechtigte PostgreSQL-Funktion.
Die persönliche Admin-API selbst war dabei aber nur mit simulierten
Datenbankantworten getestet.

Diese Änderung ergänzt denselben **realen, isolierten Redis/PostgreSQL-Test**
um den produktiven API-Handler
`DormantPersonalEditorialAdmin`. Der Test baut den echten API-Code,
verwendet den bereits vorhandenen **separaten PostgreSQL-LOGIN**
`editor_ci_fullchain` (nicht die Datenbankadministrator-Verbindung) und
fragt nach der Projektierung die reale persistierte Rangliste über
`GET /admin/editorial-ranked-events?limit=25` ab.

Der Test kontrolliert insbesondere:

- HTTP-Antwort 200 und `Cache-Control: no-store`, genau einen
  synthetischen Ereigniskandidaten mit vier Artikeln und vier Quellen (zwei RSS, Atom und JSON).
- Streng beschränkte Felder, ausschließlich Metadaten und
  `approvedForPublication=false`.
- Verbotene Schreibmethode und fehlende persönliche Anmeldung ohne
  Datenbankabfrage; ungültige Query-Parameter werden abgelehnt.
- Benutzer-Identitätsversionskonflikte werden durch
  `vns.named_current_editor()` abgewiesen.
- Wird dem realen Datenbank-LOGIN über den **ausschließlich synthetischen
  CI-Administrator** die Aktivierung entzogen, darf die API keine
  Rankingdaten mehr ausliefern. Die gespeicherten Rankings bleiben
  erhalten; die Freigabe wird im disposable Test wiederhergestellt.

Der Test benutzt weder öffentlich erreichbare HTTP-Ports noch einen
echten Browser-Cookie, Feed-URL, Nutzungsrechtedokument, Admin-Account
oder Produktionsdaten. PostgreSQL und Redis laufen nur innerhalb des
ephemeren GitHub-Runners. Es gibt **keinen** VPS-Rollout und keine
Änderungen an IONOS Backups oder Beszel.

Die persönliche API zeigt dadurch nachweislich die in der Testdatenbank
persistierten Rankings an. Eine produktive Admin-E2E-Abnahme mit echter
Anmeldung, freigegebenen Quellen, unabhängiger externer Ankerinstanz und
Restart-/Fehlerfallprüfung bleibt ausdrücklich offen.
