# P2-02 – DNS-gepinnter HTTPS-Feed-Transport (dormant)

**Nur Git/CI:** Der neue `createPinnedFeedHttpsTransport` ist in keinem
laufenden Worker importiert, registriert weder Cron noch Queue und
öffnet beim Import **keine** Netzwerkverbindung. Es wurden ausschließlich
synthetische DNS-/HTTP-Antworten getestet.

## Sicherheitsgrenzen

Der Transport verwendet den bereits geprüften
`createPinnedHttpsOptions`-Mechanismus des Research-Abrufs.
Für reale Verbindungen bedeutet das:

- Ausschließlich **exakt registrierte** `approved`-Quellen aus P2-01
  (RSS, Atom und offizielles JSON), die auch in der separaten
  HTTPS-Host-Allowlist enthalten sind. Es wird nur deren
  `baseUrl` angefragt; Artikel-Links, fremde URLs und
  `pending`/`blocked` sind keine Transportziele.
- DNS wird IPv4-only aufgelöst; **jede** IP der Antwort muss öffentlich
  sein. Der geprüfte Ziel-IP-Wert wird für den TLS-Socket fest
  gepinnt, während `Host`/`SNI` und Zertifikatsprüfung auf den
  erlaubten Hostnamen bezogen bleiben. Kein Proxy, Redirect-Follow
  oder Wechsel auf eine ungeprüfte Ziel-IP.
- HTTPS-Timeout 5 Sekunden, TLS-Zertifikatsprüfung, höchstens
  8192 Byte Antwortheader, höchstens 128 KiB Payload, keine
  Gzip-/Brotli-Kompression, striktes UTF-8 und passende
  MIME-Typen je Quellentyp. Ein inkonsistenter
  `Content-Length`-Header wird abgelehnt.
- Über `If-None-Match` und `If-Modified-Since` können zuvor
  gespeicherte ETag-/Last-Modified-Werte konditional eingesetzt
  werden. Steuerzeichen oder zu lange Headerwerte werden
  vor DNS und Request abgewiesen. HTTP 304 ist nur ohne
  Nutzlast gültig und führt nicht zu neuen Kandidaten.
- Keine unredigierten Netzwerk-/DNS-/Zertifikatsfehler
  verlassen den Adapter; es gibt keine automatische Wiederholung.

## Tests und Grenzen

Die Offline-Tests prüfen Host-/Quellenfreigabe vor DNS,
gemischte/private IPs, Pinned-IP-Weitergabe, konditionale 200/304,
Redirect-Ablehnung, Content-Type, Content-Encoding, Content-Length,
Payloadgröße, ungültiges UTF-8, Header-Manipulation und redigierte
Transportfehler. Es erfolgen **keine echten Webabrufe**.

Die Funktion ist ein möglicher späterer `FeedTransport` für den
bereits gemergten `createDormantFeedPoller`. Sie ist jedoch bewusst
**nicht eingebunden**. Die produktive Realprüfung benötigt noch einen
ausdrücklich freigegebenen Source-/ToS-Katalog, den genehmigten
PostgreSQL-Writer-Pool (siehe PR #233), Betriebs-/Restore-Freigabe,
Scheduler-/Queue-Anbindung, überwachte Logs und einen echten
End-to-End-Nachweis inklusive TLS/ETag-Verhalten.

Kein VPS-Deployment, keine echten Keys, keine KI-Anfragen,
keine produktive Migration und keine neuen kostenpflichtigen Dienste.
