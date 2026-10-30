# P2-A: kontrollierter PostgreSQL-Schema-Rollout 0048 → 0059

**Stand:** Vorbereitung für einen bewusst freigegebenen produktiven
Schema-Rollout. Kein automatischer VPS-Einsatz, keine Feed-Freigabe,
kein Neustart und keine Publikationsberechtigung.

## Nachgewiesener Ausgangspunkt

Die am 29.10.2026 übermittelte **lesende VPS-Diagnose**
bestätigt 48 von 48 P1-Migrationen bis
`0048_provider_outbox_delivery_receipt`, null P2-Migrationen,
einen sauberen Git-Checkout
`c5e46d78743aad98f87b2a8849438576c69e43ce`
sowie einen gesunden PostgreSQL-Container.
Die Migrationen 0049–0059 **wurden damit noch nicht ausgeführt**.

Dieses Dokument ist für den nach erfolgreicher CI freigegebenen
**neuen** GitHub-Commit des Schema-Rollout-Helfers zu verwenden.
Die nachfolgende `--preflight`-Prüfung ist nur mit genau diesem
Commit und sauberem `main` auszuführen. Ein lokaler Git-Update
benötigt weiterhin die separate Kontrolle des Release-Commits.

## Bedienung

Im Projektverzeichnis `/home/ap/www/videonews-studio`:

```bash
python3 scripts/p2_a_schema_0048_to_0059.py --status
python3 scripts/p2_a_schema_0048_to_0059.py --preflight
```

Beide Aufrufe sind lesend. `--preflight` akzeptiert **nur** die
vollständige, unveränderte Liste der ersten 48 Migrationen und
blockiert bei bereits teilweise installierten P2-Objekten.

### Voraussetzungen für eine gesonderte Schreibfreigabe

1. Release und Containeridentität ausdrücklich bestätigen: nur der
   geprüfte Branch `main`, sauberes Arbeitsverzeichnis, freigegebener
   SHA, und genau das gesunde Compose-PostgreSQL
   `videonews-studio-postgres-1`.
2. Das vorhandene IONOS-Backup und die für dieses Datenbankschema
   vorgesehene Wiederherstellungs-/Rollbackstrategie durch den
   Betreiber als ausreichend bestätigen; diese Anleitung legt
   **keinen zusätzlichen Backup-Dienst** an.
3. Admin-Mutationen während des kurzen Migrationsfensters
   organisatorisch anhalten; die Migrationen verwenden
   `lock_timeout=3s` und können bei Konkurrenz abbrechen.
   Weder Feed-Konsumenten noch Provider-Dienste werden neu gestartet.
4. Einen angemessenen Wartungszeitraum und Wiederherstellungsweg
   für die existierenden P1-Dienste festlegen. Schemaänderungen
   sind DDL und können selbst bei abwärtskompatiblem Entwurf
   kurzzeitig Sperren verursachen.
5. `--preflight` muss mit dem tatsächlich für die Änderung
   vorgesehenen Release-Commit erfolgreich sein.
   Der Prüfer muss den genauen SHA ausdrücklich billigen.

Erst danach ist `--apply` möglich; die beiden notwendigen
Freigabevariablen sind bewusst nicht im Compose hinterlegt:

```bash
VNS_P2_A_0059_OPERATOR_APPROVED=APPLY_ADDITIVE_0049_0059 \
VNS_P2_A_0059_EXPECTED_MAIN_SHA="$(git rev-parse HEAD)" \
  python3 scripts/p2_a_schema_0048_to_0059.py --apply
```

**Dieser Block ist eine Beschreibung des Freigabeprotokolls,
keine Aufforderung, ihn vor der gesonderten Entscheidung auszuführen.**
Das Skript verlangt Benutzer-UID 1000 und vergleicht den
freigegebenen SHA mit dem ausgecheckten Git-Commit.

## Sicherheitsmaßnahmen

- Vor der ersten Migration wird exakt `0001–0048` bestätigt.
  PostgreSQL 17, DB `videonews`, erwarteter Superuser `vns`,
  keine fehlerhafte oder unerlaubte `trust`-Hostregel,
  deaktivierte P1-Provider/Budgets sowie ausreichender
  freier Speicher sind Pflicht.
- Fehlende P2-Grundtabellen und Funktionen müssen tatsächlich
  fehlen. Eine halbe frühere Installation wird nicht übergangen.
- Das bestehende Quellenregister, die Hostfreigaben und die
  redaktionellen Profile werden vor und nach der Migration als
  **private Vergleichshashes** geprüft. Diese Hashes werden
  nicht ausgegeben.
- Die elf SQL-Dateien werden **in genau festgelegter Reihenfolge**
  einzeln ausgeführt. Vor und nach **jedem** Schritt wird das
  unveränderte Migrationsprotokoll verglichen.
- Fehler oder eine unklare Datenbankantwort stoppen sämtliche
  weiteren Änderungen. Es gibt **keine** automatische
  Wiederholung und **keine** `.down.sql`-Ausführung auf
  dem Produktivsystem; ein teilweise ausgeführter Ablauf
  bedarf separater Diagnose und Entscheidung.
- Nach 0059 müssen die neuen Ranking- und Reviewer-Tabellen
  leer sein. Der Feed-Projektor muss seine gesonderte
  Execute-Berechtigung behalten; der persönliche Admin-Client
  darf Rankingtabellen nicht direkt lesen, sondern nur die
  geschützte Lesefunktion ausführen.

## Nachgelagerte Abnahme

Bei erfolgreichem Rollout muss die bestehende reine Lesediagnose
`scripts/p2_a_readonly_acceptance.py` die Datenbankversion
`0001–0059` erkennen. **Das bedeutet allein die Installation
der technischen Voraussetzungen.** Drei bis fünf tatsächliche,
rechtlich geprüfte RSS-Quellen, persönliche Freigaben,
unabhängige Provenienz-/Faktorbewertungen, kontrollierter
Scheduler/Consumer/Projektor und die Ende-zu-Ende-Nachweise
stehen anschließend weiterhin an.

Die übermittelten IONOS-Backup- und Beszel-Betriebsangaben
bleiben bestehen und werden durch dieses Vorgehen nicht geändert.
