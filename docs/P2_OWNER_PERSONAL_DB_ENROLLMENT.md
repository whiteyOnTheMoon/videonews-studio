# P2: Persönlicher PostgreSQL-Login für den bestehenden P1-Owner

**Stand:** Ein sicherheitsgeprüfter, bewusst inaktiver
Einrichtungshelfer für einen **bereits vorhandenen** Admin. Keine
API-Aktivierung und keine Genehmigung irgendeiner Quelle, eines
Hosts oder einer Veröffentlichung.

## Tatsächlicher VPS-Befund

Die lesende Inventur des Betreibers ergab nach der erfolgreichen
Migration auf Schema 0059:

- Genau **ein Admin-Konto**, davon **ein aktives**.
- **Null** persönliche `editor_db_principals`-Einträge.
- **Null** persönliche PostgreSQL-LOGIN-Rollen und
  `vns_p2_named_client`-Mitgliedschaften.
- Quellen- und Hostregister unverändert mit Revision 0;
  keine Source- oder Host-Auditereignisse.

Die vorhandene P1-Owner-Bootstrap-Komponente legt den
kontrollierten Login `vns_owner_admin` an. Das persönliche
API-Backend erwartet für diese Identität explizit den dedizierten
SQL-LOGIN `editor_vns_owner_admin` und eine private
Datei `editor_vns_owner_admin.password`.

## Vorprüfung, ohne Schreibzugriff

Nach dem **getrennt kontrollierten** Update des VPS auf den
freigegebenen Commit mit diesem Helfer:

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p2_owner_personal_db_enrollment.py --preflight
```

Die Vorprüfung bestätigt den sauberen `main`-Checkout,
Operator-UID 1000, den richtigen gesunden Compose-Container,
die genaue PostgreSQL-Version 17 und **genau** das
Schema 0059. Darüber hinaus verlangt sie genau ein
persönliches aktives P1-Owner-Konto, ein noch leeres
persönliches Login-Register und keine Source- oder
Host-Auditereignisse.

Die private übergeordnete `secrets/`-Directory muss
dem Operator gehören und Modus `0700` besitzen. Der
Zielordner `secrets/p2-editorial-personal/` darf noch
nicht existieren. Bereits teilweise begonnene Vorgänge
werden niemals automatisch wiederholt.

## Separater, explizit genehmigungspflichtiger Schreibschritt

**Nicht im Rahmen des Pull Requests, der CI oder der
Statusprüfung ausführen.** Erst nach einem persönlichen
Betreiberentscheid kann der Helfer mit exakter SHA-Freigabe
einen separaten, zufälligen privaten Credential erzeugen,
einen dedizierten SQL-Login ohne Superuser-/CreateRole-Rechte
einrichten, ihn ausschließlich in
`vns_p2_named_client` aufnehmen und die unveränderte
bestehende Admin-ID samt aktueller `auth_version` an den
Login binden.

Die getrennten Freigabevariablen heißen
`VNS_P2_OWNER_DB_OPERATOR_APPROVED` und
`VNS_P2_OWNER_DB_EXPECTED_SHA`. Die technische
Revisionsfreigabe ist im Code als
`ENROLL_EXISTING_OWNER_ONLY` fixiert; sie ersetzt
keine persönliche Entscheidung.

Das Passwort wird nur in der neuen privaten
`editor_vns_owner_admin.password` gespeichert.
In die SQL-Transaktion gelangt ausschließlich ein mit
frischem Salt abgeleiteter SCRAM-SHA-256-Verifier,
nicht das Klartextpasswort. Die Rolle erbt nur
`vns_p2_named_client`; ein `SET ROLE` auf
den Client ist untersagt. Kein Credential gelangt
in GitHub oder in eine Kommandozeilenoption.
Eine fehlgeschlagene/unklare SQL-Antwort lässt
die entstandene private Datei bewusst stehen und
verlangt manuelle Diagnose: keine automatische
Löschung, erneute Kontoanlage oder Credential-Rotation.

**Die neue private Datei wird noch nicht automatisch in
den API-Container eingebunden.** Das separate, standardmäßig
abgeschaltete Overlay
`deploy/compose.personal-editorial-admin.yaml`
braucht einen unabhängig geprüften Mount, die beiden
Operator-Flags und einen kontrollierten Build/Start.
Ein bloßer SQL-Login schaltet keine Admin-Funktion frei.

## Unabhängige Zweitfreigabe bleibt zwingend

Die Hostfreigabe aus Migration 0023 akzeptiert einen
anderen menschlichen Reviewer als den, der die Quelle
freigegeben hat. Ein zweites Konto derselben Person darf
diese Zwei-Personen-Kontrolle **nicht** ersetzen.
Dieser Einrichtungshelfer erzeugt **keinen** zweiten
Prüfer und vergibt weder
`vns_source_admin_writer` noch
`vns_host_approval_writer`.

Außerdem sind die Quellen- und Hosthandler derzeit im
produktiven `apps/api/src/index.ts` noch nicht
angeschlossen. Vor ihrem späteren Einsatz müssen
persönlich authentifizierte SQL-Writer zusätzliche
`session_user`-Kontrollen erhalten. Das bestehende
`PostgresSourceAdminStore` und
`PostgresHostApprovalStore` reichen ohne sicheren
Runtime-Mount und Identitätsbindung nicht aus.

## Grenzen

Ein grüner Unit-Test ist **keine** produktive
Anmeldung. Die IONOS-Backups und Beszel-Überwachung
bleiben wie vom Betreiber bestätigt unverändert.
Das Schema 0059 ist installiert, aber ein Ende-zu-Ende-
Nachweis der lizenzierten Nachrichtenquellen fehlt weiterhin.
