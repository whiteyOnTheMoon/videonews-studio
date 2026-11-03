# P2-02 – Nur-Lesen-Netzwerkdiagnose für die drei RSS-Quellen

Der erste genehmigte P2-Canary erstellte den gültigen Checkpoint und
die drei Feed-Poll-Leases, jedoch keine Kandidaten. Eine anschließende
HEAD-Probe auf `feed_egress` meldete für NASA `dns_rejected`, für NOAA
und USGS `https_or_tls_unavailable`; die beiden Kategorien sind noch
keine nachgewiesenen Ursachen.

`scripts/p2_02_readonly_https_head_probe.mjs` nimmt nur die drei
aktuellen IDs sowie die dazugehörigen, bereits in PostgreSQL
freigegebenen Hostnamen aus dem JSON-Eingabestrom an. Eine HEAD-Anfrage
pro Quelle nutzt die bestehende öffentliche IPv4-Prüfung und den
DNS-gepinnten TLS-Request des Workers. DNS-Antworten mit einer
nichtöffentlichen Adresse oder mehr als 16 Einträgen bleiben verboten.
Es gibt keinen IP-Fallback und keine Redirect-Verfolgung.

Die Ausgaben sind ausschließlich Source-ID, Anzahl/Verboten-Zählung der
DNS-Antworten, feste Fehlercodes oder HTTP-Status, MIME-Kategorie und
Kompressionsflag. Für unbekannte Fehler werden nur feste Fehlerfamilien und
der TCP-/TLS-Verbindungsfortschritt gemeldet. Keine IP-Adressen, URL-Pfade,
SSL-Fehlermeldungen, Antwortkörper oder Zugangsdaten werden geloggt.

Die bisherige globale Sperre für `192.0.x.x` war zu breit: Auch öffentliche
NASA-CDN-Adressen aus `192.0.66.x` wurden abgewiesen. Die gemeinsame
Worker-DNS-Sperre blockiert jetzt nur `192.0.0.0/24` und
`192.0.2.0/24` sowie alle zuvor gesperrten übrigen Bereiche. Tests
belegen den weiterhin geschlossenen Transport zu privaten IP-Adressen.

Dieser Test braucht keine Feed-Secrets und darf nur mit dem getrennten
`videonews-studio_feed_egress`-Docker-Netz ausgeführt werden. Er
öffnet keine PostgreSQL- oder Redis-Verbindung im Container und setzt
weder Lease noch Checkpoint zurück. Er ist kein Feed-GET und beweist
keine erfolgreiche XML-/Metadatenverarbeitung.
