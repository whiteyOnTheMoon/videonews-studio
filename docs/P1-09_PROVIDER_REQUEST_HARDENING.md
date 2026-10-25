# P1-09 – Fail-closed HTTP-Schreibanfragen für KI-Anbieter

Die **weiterhin nicht produktiv injizierte** API-Komponente
`apps/api/src/admin-provider-configuration.ts` nimmt synthetische
POST-JSON-Kommandos nur unter strenger, bytebasierter Begrenzung an.

- Maximal 1024 Body-Bytes, unabhängig von eventuellen HTTP-Längenangaben.
- Falls `Content-Length` gesetzt ist: kanonische nichtnegative Dezimalzahl,
  höchstens 1024 Bytes, exakte Übereinstimmung mit den empfangenen Bytes.
- `Content-Encoding` wird abgewiesen; keine stille Dekompression.
- UTF-8 wird mit fatalem Decoder behandelt, statt fehlerhafte Bytes zu ersetzen.
- Empfangene Buffer werden soweit möglich nach Parsing geleert; wie bei allen
  JavaScript-Strings ist dadurch keine vollständige Speicherbereinigung garantiert.
- Fehler bleiben generisch, der SQL-Mutationsadapter wird nicht aufgerufen.

Offline-Tests prüfen falsche/überhöhte/mehrdeutige Längen, komprimierte
Anfragen, ungültiges UTF-8 sowie eine gültige längenkorrekte Anfrage.
Diese Tests sind kein echter Reverse-Proxy-Test und keine Abnahme
eines produktiven Rate-Limits.

**Keine Betriebsfreigabe:** `index.ts` injiziert nach wie vor keinen
Provider-Handler. Die GET-only-BFF-Route, Admin-Oberfläche, DB-Migrationen,
Provider-Budgets und KI-Aufrufe bleiben unverändert. Vor einer echten
Schlüsselannahme fehlen insbesondere persönliche Auditidentität,
produktive Least-Privilege-DB-Rolle, Ratenbegrenzung über Instanzen hinweg,
Master-Key-Custody samt Recovery und ein genehmigter Rollout. Beszel,
Docker und VPS bleiben unverändert; Offsite-Backup ist weiterhin vertagt.
