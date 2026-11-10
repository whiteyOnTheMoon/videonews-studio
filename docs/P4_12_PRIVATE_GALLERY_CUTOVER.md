# P4-12 – Private Studio-Videomediathek: zielgerichteter API/Web-Cutover

**Status: Deployment-Werkzeug, nicht Live-Deployment.** Betrifft #483 und den gemergten PR #481. Die Freigabe für Merges und das Ein-Personen-Reviewverfahren ist erteilt; eine Änderung laufender Dienste erfordert weiterhin eine **separate ausdrückliche Live-Freigabe**.

## Fest gepinnter Release und funktionale Grenzen

- Web: `ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:6b077023c71caf5c16fdc41e48ae4791f6acc21636b92e0529570bc740af8136`
- API: `ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:88af6d3348dab85aaf287e2ffde433fda1cc39df2c6f4a78824dfea1e568af02`
- Ihre OCI-Source-Revision ist `a51336ed708bbc0055b1f7722a2da47f4e817bfc`. Die beiden Images wurden auf dem VPS bereits **digest-geprüft geladen**, ohne aktive Container zu ändern.
- Bisherige API-Image-ID: `sha256:473c3c994957d368a5eadec16502908e72358655f1c9925fec9643cc3aac424a`.
- Bisherige Web-Image-ID: `sha256:75e2f6156a20061d73644857c193a8ea52fff0517576a6a8cdd66f82f219ea9a`.
- Das API bekommt einen **read-only** Bind für `/home/ap/videonews-previews`; Web bekommt keinen Preview-Mount. Der Hostordner bleibt UID 1000/0700, das Testvideo 0600. Verändere diese Rechte nicht.
- `VNS_WEB_PRIVATE_PREVIEWS_ENABLED=true` und `VNS_PRIVATE_PREVIEWS_API_ENABLED=true`; **beide Render-Flags=false**. Dies ermöglicht nur das Anzeigen/Streamen/Herunterladen vorhandener MP4s, nicht das Rendern aus dem Web, keine neue Recherche und keine Veröffentlichung.
- Cloudflare-Tunnel, Postgres, Redis, Worker, andere VPS-Apps und Secret-Inhalte sind nicht Bestandteil des Cutovers.

## Vorprüfung (nach Merge dieses Operators, vor Live-Freigabe)

Auf dem VPS als `ap`, nur mit sauberem `main` exakt auf dem finalen Merge-Commit `EXACT_OPERATOR_MAIN_SHA`:

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  python3 scripts/p4_12_private_gallery_cutover.py \
    --preflight --expected-operator-sha EXACT_OPERATOR_MAIN_SHA
)
```

Das Werkzeug verweigert einen unbekannten Git-Stand, nicht übereinstimmende bisherige Container-Image-IDs, fehlende lokale alte/neue Images, fehlende Quellrevision, gesperrte Speicherreserven, unpassende alte fünf Compose-Dateien, ein verändertes Secret-Verzeichnis, unerwartete Mounts/Ports/Netzwerke, einen veränderbaren Private-Video-Mount oder nicht strikt deaktivierte Render-Flags. Es verwendet `docker compose config --format json` **nur intern** und druckt keinerlei Compose-Konfiguration/Secrets ins Terminal.

## Einmaliger Cutover (nur nach expliziter Live-Deployment-Freigabe)

Nach erfolgreichem Preflight und zusätzlicher Betreiberfreigabe:

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  python3 scripts/p4_12_private_gallery_cutover.py \
    --apply \
    --operator-approval PRIVATE_GALLERY_API_WEB_ONLY \
    --expected-operator-sha EXACT_OPERATOR_MAIN_SHA
)
```

Das Werkzeug startet **nur API und Web** einzeln mit `docker compose up --no-deps --no-build --pull never --detach --wait`. Für neue Images verwendet es genau die sechs bekannten Compose-Dateien; für einen Fehler-Rollback wieder exakt die **vorherigen fünf**, sodass der vorherige API-Container den neuen Preview-Mount und die Preview-Flags nicht behält. Nach jedem Schritt werden Postgres/Redis/Worker auf unveränderte IDs und Startzeitpunkte geprüft. Bei einem catchbaren Fehler wird genau ein begrenzter API/Web-Rollback versucht; **kein automatischer unendlicher Wiederholungsversuch**.

Eine unerwartete SSH-Unterbrechung, SIGKILL oder ein VPS-Neustart kann zwischen den beiden Schritten liegen. In diesem Fall **nicht blind neu starten**; aktuelle Docker-IDs, Compose-Konfigurationslabels und Gesundheitsstatus gezielt auswerten. Ein automatischer Rollback ist für uncatchbare Abbrüche nicht garantiert.

## Nachprüfung

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  python3 scripts/p4_12_private_gallery_cutover.py \
    --status --expected-operator-sha EXACT_OPERATOR_MAIN_SHA
)
```

Danach **manuell im Browser** den Besitzer-Admin-Login und die persönliche Editor-Admin-Sitzung neu herstellen (API-Neustart kann vorhandene Sitzungen ungültig machen): `https://studio.ap-pixels.com/admin`. Im Tab „Videos“ die Liste und den echten MP4-Stream prüfen, vorspulen (Range-Response 206), herunterladen und Dateigröße/Hash prüfen. Nicht angemeldeter und nicht-admin Editor-Zugriff müssen verweigert werden. Die private Cloudflare-Zugangspolitik gesondert im bestehenden Setup verifizieren; ein Tunnel allein bedeutet keine Zugangsbeschränkung. Ein Download-Link darf nicht ohne aktive Sitzungen funktionieren.

**Noch ausstehend:** Echte aktuelle News-Recherche, freier redaktioneller Video-Erstellungsbutton und hochwertige Sprecherstimme. Die vorhandene Ozonloch-MP4 ist ein Pilot mit eSpeak-Technikstimme. Keine automatische Video-/YouTube-Veröffentlichung.
