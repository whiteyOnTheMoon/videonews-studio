# P2-02 – Operator-selected NOAA persistence canary (code only)

This change adds a **separately authorized one-shot diagnostic subset**, not
a change to an approved source, the signed export, publisher key, high-water
checkpoint, Poll-Lease, Redis ACL, or scheduled production polling.

The full three-source registry is still verified against signed publisher
export and current PostgreSQL Source/Host grants. The minimum 3–5 source
requirement and Queue slot identity remain intact. The manually invoked
`feed-observer` may optionally poll **only** `noaa_news` while it is an
approved, RSS, `metadata_only` source on `www.noaa.gov`. The nonselected
sources receive **no** authority SQL query, Poll-Lease, DNS, HTTPS request or
metadata write.

## Fail-closed gates

All existing observer admission flags, trust-policy revision, initial
checkpoint admission, distinct PostgreSQL/Redis logins, signed source
verification, reviewed host allowlist and operator rights attestations
remain mandatory. Additionally, the operator must set precisely:

- `VNS_FEED_RUNTIME_MODE=single_pass`
- `VNS_FEED_SOURCE_BOOTSTRAP=false` (existing checkpoint must be preserved)
- `VNS_FEED_CANARY_SOURCE_ID=noaa_news`
- `VNS_FEED_CANARY_OPERATOR_ACK=NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY`

These are an **opt-in**, not a substitute for independent operator
authorization of the actual production release and Source/Host rights.
There is no fallback to any other source if NOAA is denied. A selector
without the exact acknowledgement, or in a persistent worker, scheduler or
producer, is rejected before opening any secrets or network connections.

The `feed-observer` retains a single bounded BullMQ job, 45-second job
wait, one per-source SQL lease subject to the existing interval, bounded
HTTPS and metadata-only SQL commit. A repeated run while NOAA's lease is
ineligible may return no new candidates. Never clear the existing lease or
checkpoint to force a retry. No AI research or publication is enabled.

## Operator review before permission to run

1. Verify the exact clean `main` release SHA, **current** signed source
   revision and Host grant (the latest audited production snapshot was
   **10/10** on 2026-11-07), pinned trust-policy revision, checkpoint state
   and the separately documented NOAA rights and exact feed URL. Never
   reuse stale 8/7 assumptions from older canary runs, and never trust this
   10/10 snapshot if any source/host approval has subsequently changed.
2. Read the pre-existing NOAA Poll-Lease and verify that it is eligible.
   Check isolated feed BullMQ queue status and reject if a current or
   failed job would conflict with the intended one-shot 15-minute slot.
3. Separately confirm the operator's authorization for **one NOAA-only
   metadata persistence** canary and its exact host/network/write scope.
4. Invoke only the existing `feed-observation` Compose profile, with
   approved runtime secrets and the gates above. Do not run any bounded or
   continuous producer/consumer and never enable bootstrap.
5. Verify PostgreSQL counts and source authority audit, projection,
   ranking and authenticated Admin views separately. A successful
   observation count is not proof of persisted projection or editorial
   approval; zero newly inserted candidates can be normal after
   deduplication.

Do not run this from CI or with an unsigned/fabricated source snapshot.
No API/publishing access, unsafe feed shortcuts or source revision resets
are included. Enabling this mode requires a separate, current
operator-reviewed VPS command.


## Tatsächlicher produktiver Read-only-Status, 07.11.2026

Im sauberen VPS-`main` mit SHA
`40f8d3a83864472fe08f4624fb69a7c456c4d340` hat der
Betreiber nacheinander **ohne SQL-/Redis-Schreibzugriff und ohne HTTPS-GET**
bestätigt:

| Guard / Zustand | Beobachtetes Ergebnis |
| --- | --- |
| Quellen-/Host-Freigaben | 10/10, `noaa_news` = approved, Host-Freigabe aktuell |
| NOAA-Poll-Lease | 60 Minuten, `next_eligible_at=2026-11-04T00:21:23.535625+00:00`, `lease_due=true` |
| Signatur / privater Stage-Inbox-Abgleich | gültig, identische Bytes |
| Privater Checkpoint / signierter Umschlag | 10/10, übereinstimmend |
| SQL-Source-Anchor / Trust Policy | Digest, Revision, Hosts und Policy korrekt |
| `sql_full_registry_equal_signed` | `false` (zulässig: das Gesamtsystem enthält auch Quellen außerhalb der genehmigten Host-Teilmenge) |
| `sql_approved_host_subset_equal_signed` | `true` (für die Freigabe maßgeblich) |
| Feed-Redis-ACL | getrennte Producer-/Consumer-Anmeldungen verifiziert |
| BullMQ derzeit | active/waiting/delayed/paused/prioritized/stalled/repeat = 0 |
| Historische BullMQ-Jobs | failed = 6, completed = 2; **beide unverändert aufbewahren** |
| Current-/Previous-Queue-Slot | beide ohne Job |
| Signaturprüfung / Queue-Diagnose | `parity_reviewable` / `reviewable` |
| Historische NOAA-Projektion | 10 Artikel / 10 Ereignisse; **0** aktuell im Profil-Altersfenster |
| Herausgeber-Provenienzreview | **nicht** persönlich erfasst |

**Diese Ergebnisse belegen eine vorbereitete technische Momentaufnahme – keine
erlaubte Betriebsaktion.** Insbesondere berechtigt der zeitlich abgelaufene
SQL-Lease **nicht** zu einem neuen HTTP-Abruf, Redis-Job oder
PostgreSQL-Commit. Die bisherigen erfolgreichen Einzelprüfungen wurden
mit der Quellcodebasis dieses SHAs und nicht mit einem neuen Worker-Image
durchgeführt.

### Noch offen vor einem ausdrücklich autorisierten NOAA-Einzelabruf

1. Betreiber prüft die genaue NOAA-RSS-URL sowie aktuelle
   Nutzungsbedingungen/Metadatenrechte erneut und attestiert den
   quellenspezifischen zulässigen Umfang. Herausgeber-/Syndikationsprüfung
   ist eine **andere** Aufgabe und wird durch technische Host-Freigaben
   nicht vorweggenommen.
2. Operator bestätigt den **exakten** zu startenden Worker-Image-Digest,
   die eingebettete OCI-Revision, den vorhandenen unveränderten
   `single_pass`-NOAA-Selector und die Ressourcen-/Isolationseigenschaften
   der dedizierten Compose-Ausführung. Kein lokaler Build oder ungeprüfter
   `latest`-Pull und keine automatische Aktivierung.
3. Direkt vor dem Start erneut 10/10 oder die dann **aktuelle**
   monotone Signed-Source-/SQL-Anchor-/Checkpoint-Parität, aktuelle
   NOAA-Host-Audit-Freigabe, Poll-Lease, Feed-Queue-Slot und ruhende
   Feed-Dienste **ausschließlich lesend** kontrollieren. Die zeitlichen
   Snapshots von 07.11.2026 sind nicht übertragbar.
4. Nur nach **separater ausdrücklicher Erlaubnis** für genau einen
   `noaa_news`-Metadaten-GET mit dem bestehenden 60-Minuten-Intervall,
   einem einzigen Queue-Tick, maximal 20 zugelassenen RSS-Kandidaten
   pro Antwort, ohne Bootstrap, ohne einen zweiten Feed, ohne
   Dauer-Producer/Consumer und ohne Publikation darf ein
   dedizierter one-shot-Betriebsbefehl vorbereitet werden. Dieser Abruf
   kann einen SQL-Poll-Lease und einen BullMQ-Job erzeugen und ist
   daher **kein** read-only Test.
5. Bei Timeout, unklarem Resultat oder Null Kandidaten: **nicht wiederholen**,
   nicht die Lease-/Queue-Daten manipulieren und nicht die historischen
   6 Fehljobs oder 2 abgeschlossenen Jobs löschen. Erst einen neuen
   lesenden SQL-/Redis-Witness ausführen. Bei Erfolg müssen frische
   Artikel zunächst getrennt projektions- und revisionssicher bestätigt
   werden; erst echte, unabhängige passende Mehrquellenereignisse dürfen
   den bestehenden Mindestquellen-/Publisher-Review-Gate passieren.

Die Quellcode-Synchronisierung des Runbooks, ein grüner GitHub-PR und ein
`reviewable`-Status **autorisieren keinen neuen Feed-Lauf**.
