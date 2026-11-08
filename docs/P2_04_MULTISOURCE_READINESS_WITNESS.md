# P2-04 – Read-only Multisource-/Ranking-Bereitschaft

**Status: Diagnosecode und isolierte Unit-Tests. Kein Feed-Start, kein Datenbank-Rollout, keine Freigabe für Publisher.**

## Zweck

Der P2-02/03-Pfad kann Feed-Kandidaten in PostgreSQL speichern
und über den eingeschränkten DB-only-Projektor in Rechercheartikel/Ereignisse
überführen. Ein erfolgreich projiziertes Ereignis erscheint jedoch **nur
dann** in der redaktionellen Rangliste, wenn die bestehenden
Profil-, Alters-, Sperrlisten-, Herkunfts- und Review-Regeln erfüllt sind.
Eine leere Admin-Rangliste ist nicht gleichbedeutend mit „kein Feed importiert“.

Nach dem einmaligen NASA-Projektor wurden am 07.11.2026 ausschließlich
lesend folgende Daten nachgewiesen:

| Quelle | Feed-Kandidaten | Persistierte Artikel/Ereignisse | Aktuell im Profil-Altersfenster | Herausgeber-Provenienzreview |
| ------ | --------------: | ------------------------------: | ------------------------------: | ---------------------------- |
| NASA   |               1 |                             1/1 |                               1 | nein                         |
| NOAA   |              10 |                           10/10 |                               0 | nein                         |
| USGS   |               0 |                             0/0 |                               0 | nein                         |

Das aktuelle redaktionelle Profil verlangt **mindestens zwei verschiedene
Quellen-IDs**, doch der NASA-Artikel ist allein. Zwischen den gespeicherten
NASA-/NOAA-Artikeln gibt es **keinen** zeitlich zulässigen Paarvergleich
innerhalb von 48 Stunden und kein gemeinsames Ereignis. Eine solche
Zeitnähe alleine würde _noch keine_ thematische Gleichheit beweisen.
Die zehn älteren NOAA-Ereignisse dürfen nicht künstlich mit NASA
zusammengeführt werden.

## Produktiver Aufruf – ausschließlich lesend, erst nach Quellcode-Synchronisierung

Der Betreiber muss den vollständigen freigegebenen SHA einsetzen, niemals
einen unkontrollierten HEAD als „geprüften Release“ ausgeben. In einem
sauberen main-Checkout unter /home/ap/www/videonews-studio:

    (
      set -euo pipefail
      cd /home/ap/www/videonews-studio
      EXPECTED_SHA="EXAKTER_40_STELLIGER_GEPRUEFTER_MAIN_SHA"
      python3 scripts/p2_04_multisource_readonly_readiness.py \
        --expected-sha "$EXPECTED_SHA" \
        --source-ids nasa_news,noaa_news,usgs_news |
        python3 -m json.tool
    )

Das Skript importiert den bereits CI-getesteten P2-03-Release-Preflight:
Betreiber ap (UID 1000), sauberes main und _exakt_ erwarteter SHA
sowie gesunder Compose-PostgreSQL-Dienst. Es verwendet nur eine
PostgreSQL-Sitzung mit
default_transaction_read_only=on, statement_timeout=10000 und
lock_timeout=3000. IDs sind strikt auf 2–5 verschiedene Quellenkennungen
beschränkt. SQL-Abfragen lesen ausschließlich aggregierte Metadaten und
die Host-Audit-Momentaufnahme.

Insbesondere wird die produktive Autorisierungsfunktion
vns.feed_runtime_source_authorized **nicht** aufgerufen, weil diese
FOR SHARE-Sperren benötigt; das Diagnoseergebnis ist ausdrücklich
**keine operative Quellenfreigabe**. Es werden keine Schlagzeilen,
URLs, Artikeltexte, Hostnamen, Zugangsdaten oder SQL-Fehler ausgegeben.

Der Bericht zeigt die Quellen- und Host-Auditstatus, persistierte Kandidaten-,
Artikel- und Ereigniszahlen, Altersfenster-Eignung, Herausgeber-Review-Status,
verschiedene aktuelle Quellen-IDs, bereits zusammengeführte Ereignisse,
**nur zeitlich passende** unterschiedliche Artikelpaare, gespeicherte
Rankings und verbotene Veröffentlichungsflags.

Die Diagnose gibt eine priorisierte Warte- oder Blockerkennung aus.
**Jeder Status ist informativ und berechtigt weder zum Feed-Start
noch zur Veröffentlichung.** Die tatsächliche Unabhängigkeit von
Herausgebern kann nicht durch eine einzelne Provenienzzeile bewiesen werden.

## Isolierte Tests und Grenzen

Der neue Python-Unit-Test simuliert alle externen Aufrufe und prüft die
07.11.2026-Produktionszählungen, SQL-Lesegrenzen, manipulierte Zähler und
unzulässige Quellen-IDs. Der eigene GitHub-Actions-Workflow benötigt keine
Docker-Dienste, GHCR-Credentials, VPS-Netzwerke oder Nachrichtenquellen.

Der Bericht prüft **nicht**: Urheber- oder Nutzungsrechte, faktische
Übereinstimmung der Schlagzeilen, Herausgeberunabhängigkeit,
Keyword-/Sperrlisten-Score, Unicode-Parität, persönlichen Admin-Login,
spätere Feed-Aktualisierung, Recovery oder Veröffentlichung.
Hierfür bleiben die bestehenden persönlichen Reviewer-Gates und die
P2-03/04-Produktivabnahmen erforderlich.

**Betriebsregel:** Alle vier NASA-Canarys, sechs historische Fehljobs
und zwei abgeschlossene Queue-Jobs unverändert bewahren. Kein erneuter
NASA-GET, kein Projektor-Replay, keine automatische Profilabsenkung,
keine künstliche Quell- oder Review-Evidenz.
