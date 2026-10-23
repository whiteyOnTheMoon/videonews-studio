# P1-04: Docker-Compose-Grundgerüst (noch nicht ausgerollt)

> **Kein produktives Deployment.** Diese Konfiguration wird auf GitHub vorbereitet und im CI nur syntaktisch geprüft. Auf dem VPS wurden keine Container, Images, Netzwerke oder Ports für VideoNews Studio erstellt.

## Verbindliche Sicherheits- und Ressourcenentscheidungen

- Der Stack hat den eigenen Compose-Projektnamen `videonews-studio`; keine statischen `container_name`-Werte oder Host-Netzwerkfreigaben.
- Sämtliche Dienste besitzen nur **Opt-in-Profile**. Einfaches `docker compose up -d` soll ohne Profil keinen Dienst starten.
- **Keine `ports:`-Einträge**: Web, API, Postgres, Redis und Caddy sind vom Host beziehungsweise Internet aus nicht durch veröffentlichte Docker-Ports erreichbar.
- Getrennte Netzwerke: `frontend` für Web/Proxy/API; `backend` mit `internal: true` für API, Worker, Postgres, Redis. Postgres/Redis/Worker sind ausschließlich im Backend.
- Web, API und Worker laufen mit einem nichtprivilegierten Node-Benutzer, read-only Root-Dateisystem, eingeschränkten Capabilities und festen RAM-/CPU-/PID-Grenzen.
- Ressourcenlimits sind nur **Startvorschläge**, keine Kapazitätsfreigabe. Geplanter Preview-Stack Web 640 MiB + API 192 MiB; optionale Datencontainer Postgres 320 MiB und Redis 144 MiB; Caddy 96 MiB. Worker 768 MiB bleibt deaktiviert.
- Postgres-Passwort wird ausschließlich aus einer lokalen Compose-Secret-Datei eingelesen. Das Passwort wird nicht in Git hinterlegt.
- **Redis bleibt absichtlich mit `protected-mode yes` gesperrt**, bis P1-07 die Authentifizierung und Queue-Verbindung einrichtet. P1-04 verwendet Redis noch nicht produktiv.
- Der aktuelle Worker beendet sich nach seiner Begrüßungsmeldung. Er ist ausdrücklich noch **kein laufender Queue-/Render-Worker**.
- Caddy kann ausschließlich ein internes HTTP-Proxysignal unter Port 8080 innerhalb des Projektnetzes bereitstellen. **HTTPS und öffentliches Routing sind noch nicht umgesetzt.** Vor jedem Anschluss an das existierende VPS-Ingress sind vorhandene Cloudflare-/Proxy-Konfigurationen zu prüfen. Keine bestehenden Anwendungen anpassen.
- Das Web ist nur eine Platzhalterseite **ohne Admin-Authentifizierung** (P1-06). Deshalb darf kein öffentlicher Zugriff angeschaltet werden.

## Profile (Definitionen, keine Startfreigabe)

| Profil    | Dienste         | Zweck                                              |
| --------- | --------------- | -------------------------------------------------- |
| `preview` | web, api        | Interne Entwicklungsansicht                        |
| `data`    | postgres, redis | Datenbasis erst nach Freigabe                      |
| `ingress` | web, caddy      | Interner HTTP-Proxy, noch kein HTTPS               |
| `worker`  | worker          | Einmaliger Platzhalterprozess, **nicht produktiv** |

Erst nach VPS-Prüfung, unabhängiger/ausdrücklich genehmigter PR-Abnahme und schriftlicher Freigabe für genau diesen Stack darf ein Startkommando ausgeführt werden. Ein in Zukunft zulässiger Start wäre etwa `docker compose --profile preview up --build -d` im eigenen Projektverzeichnis, **aber noch nicht jetzt ausführen**.

## Prüfung ohne Start von Containern

Im GitHub-Actions-Runner erfolgen Python-Policytests und `docker compose config`; die Tests erzeugen dort ein rein temporäres Dummy-Secret. Auf dem VPS sind die Dateien `secrets/postgres_password` noch nicht angelegt; dies wird erst vor Aktivierung des Datenprofils separat und ohne Ausgabe des Secret-Inhalts vorbereitet.

## Abschlussblocker für P1-04

1. VPS-Inventur: Docker-Compose-Version, bestehende Netzwerke, offene Ports, Cloudflare-/Proxy-Entrypoints, RAM/Swap, freier Speicher; **keine Container stoppen oder neu starten**.
2. Ressourcenlimits gegen die tatsächlich verfügbaren Kapazitäten prüfen.
3. Dockerfile-Build der Anwendungsziele und Healthchecks isoliert testen, inklusive Next.js-Dateisystem- und Netzwerkbindung.
4. Entscheidung für vorhandenen Ingress oder Caddy-HTTPS mit nachgewiesener TLS-Termination und nur einem exponierten Web/Proxy-Endpunkt.
5. Keine produktive Adminoberfläche vor P1-06, keine Queue-/Redis-Verbindung vor P1-07.
6. Betreiberfreigabe, Review- und CI-Abnahme dokumentieren.

**Achtung zu Backups:** Off-Site-/kostenpflichtige Backups wurden für die Hobby-Projekte ausdrücklich auf später verschoben. Persistent-Volumes ersetzen kein Backup; bei VPS-Verlust droht Datenverlust. Keine unautorisierten kostenpflichtigen Angebote nutzen.

## Interner Preview-Ablauf und Ingress-Entscheidung

Die verbindliche Entscheidungsvorlage und der rein lesende Ressourcen-/Kollisionscheck befinden sich in [INTERNAL_PREVIEW.md](INTERNAL_PREVIEW.md) und `scripts/preflight_vps.py`. CI hat den Docker-Build bereits auf GitHub Actions erfolgreich nachgewiesen; **auf dem VPS ist noch kein Build oder Start erfolgt**. Wegen 24 GB freiem Speicher und deutlich belegtem Swap werden lokale Builds bis zur expliziten Freigabe zurückgestellt. Ein erster Preview-Test wäre ausschließlich Web+API ohne Host-Port-Mappings, aber erst nach Checkout-, Ressourcen- und Sicherheitsprüfung.

**TLS:** Ein öffentlicher HTTPS-Einstieg und eine bestehende Cloudflare-Integration werden hier absichtlich **nicht** als umgesetzt behauptet. Der bestehende Tunnelbestand wird nicht angerührt. Eine spätere externe Freigabe erfordert P1-06-Authentifizierung sowie die dokumentierte TLS-/Zugriffsentscheidung.
