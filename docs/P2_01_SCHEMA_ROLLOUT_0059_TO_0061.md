# P2-01 controlled PostgreSQL schema 0059 to 0061

**Scope:** Schema-only preparation for personally bound sources and the separately audited Single-Owner review option. The VPS must remain on its previous healthy API and Web containers. This operation does **not** grant any source, host, owner policy, provider budget or publication authority.

## Preconditions

The operator has accepted the existing IONOS backup and Beszel monitoring arrangements. Do not replace those with new tooling. Confirm an appropriate recovery point exists under the accepted IONOS backup plan before a production schema change.

Use the personal `ap` VPS user inside `/home/ap/www/videonews-studio` on a clean `main` checkout, synchronised to the **exact reviewed release SHA**. Verify the migration files 0060 and 0061 and the helper are in that release. Never use the ephemeral CI SQL test fixtures against the VPS.

The script requires:

- Healthy `videonews-studio-postgres-1` container with the exact Compose project and service labels.
- PostgreSQL 17, the expected local database identity, safe authentication, all required named SQL gateway roles already installed, and all paid provider switches disabled.
- Exactly the 59 installed migrations through `0059_canonical_event_title_fingerprint`; 0060 or 0061 must not be partially installed.
- Empty source and host registries (including revision zero), empty source/host audit, and no published event rankings.
- A clean source/host/profile snapshot, unchanged across both migrations.
- Sufficient free disk and available memory; two verified additive SQL transactions with no implicit retry.

## Read-only inventory

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p2_01_schema_0059_to_0061.py --status
python3 scripts/p2_01_schema_0059_to_0061.py --preflight
```

These commands only read Git, Docker container metadata, available resources and PostgreSQL read-only queries. They do not read credential material, restart containers or change data.

## Production application: separate owner authorization required

After the exact release SHA and baseline preflight are personally verified, the operator may explicitly authorize the **schema-only** changes in an interactive VPS session. Set `VNS_P2_0061_EXPECTED_MAIN_SHA` to the **literal 40-character reviewed SHA**, not a dynamically computed or guessed value.

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  VNS_P2_0061_APPLY_APPROVED=INSTALL_SCHEMA_ONLY_0060_0061 \
  VNS_P2_0061_EXPECTED_MAIN_SHA=REPLACE_WITH_INDEPENDENTLY_VERIFIED_40_HEX_SHA \
    python3 scripts/p2_01_schema_0059_to_0061.py --apply
)
```

The helper checks the exact `main` SHA and clean worktree, then applies **0060 followed by 0061** in separate SQL transactions and validates each installed ledger step. If the second step fails after the first commits, **do not rerun or apply a `.down.sql` file**. Record the partial state, stop and investigate; automatic rollback of a production schema is not supported.

## Separater Pfad: vorhandene geprüfte Register erhalten

Wenn ein bestehendes 0059-System **bereits Quellen, Hostfreigaben und
Audit-Einträge** enthält, sind die obigen Leerregister-Voraussetzungen
nicht erfüllt. **Keinesfalls** Register oder Audits löschen, auf Revision
null zurücksetzen oder Freigaben erneut erzeugen, nur um den normalen
Upgrade-Pfad zu ermöglichen.

Hierfür existieren die getrennten Aktionen
`--preflight-reviewed` (nur lesend) und `--apply-reviewed` (zwei
schemaändernde Transaktionen, nur nach ausdrücklicher Freigabe).
Sie verlangen drei bis fünf bereits auf `approved` gesetzte Quellen,
nichtleere geprüfte Hostfreigaben und bestehende Quell-/Hostaudits.
Sie vergleichen die bestehenden Quell-, Host- und Profilregister sowie
**beide vollständigen Audit-Reihen** anhand revisionsgebundener
Fingerabdrücke vor und nach den SQL-Migrationen. Die von 0061
neu ergänzte Spalte `approval_model` wird dabei nur für die
Vergleichsberechnung ausgeklammert; Auditzeilen werden nicht verändert
oder aus der Datenbank gelöscht.

Zuerst ausschließlich lesend prüfen:

```bash
cd /home/ap/www/videonews-studio
python3 scripts/p2_01_schema_0059_to_0061.py --status
python3 scripts/p2_01_schema_0059_to_0061.py --preflight-reviewed
```

Für den schreibenden Schritt ist **eine separate persönliche
Betreiberentscheidung** über den genauen Release-Commit, den
vorhandenen Registerzustand und den zulässigen Schema-Upgradeumfang
erforderlich. Die drei Werte sind explizit zu setzen und dürfen
nicht von einem automatisch ausgelesenen HEAD hergeleitet werden:

```bash
cd /home/ap/www/videonews-studio
VNS_P2_0061_APPLY_APPROVED=INSTALL_SCHEMA_ONLY_0060_0061 \
VNS_P2_0061_EXPECTED_MAIN_SHA=INDEPENDENTLY_REVIEWED_40_HEX_SHA \
VNS_P2_0061_REVIEWED_STATE_APPROVED=PRESERVE_EXISTING_REVIEWED_SOURCE_AND_HOST_REGISTERS \
  python3 scripts/p2_01_schema_0059_to_0061.py --apply-reviewed
```

**Nicht ausführen, bevor der Betreiber den aktuellen Produktionszustand
und den Release ausdrücklich freigegeben hat.** Die Prüfung ist für den
**genauen** Zustand vor 0060 gedacht. Ist 0060 bereits installiert,
wird ein manueller Abgleich erforderlich; es erfolgt kein automatischer
zweiter Versuch. Der Upgrade-Pfad erzeugt **keine** Nutzungsrechte,
unabhängigen Ankerfreigaben, Owner-Policy-Aktivierung oder Live-Feed-Läufe.
Ein erhaltenes `approved`-Feld allein ist ausdrücklich **kein
Lizenznachweis**.

## Post-installation acceptance

The successful result must show both migrations, matching source/host/profile snapshots, personal SQL grants (without any API shared-writer or direct owner-policy grant), and `single_owner_review_policy.enabled=false` with no owner assigned. The new owner policy is **not** enabled merely by installing 0061.

Separately review and deploy the API image from a digest-pinned release. Its Source/Host administration flags remain default OFF until explicit personal-account and HTTPS/Cloudflare-Access validation. Only after that should the operator separately decide whether to enable the owner policy, enter genuinely licensed sources as pending, and approve each source/host with audited reasons.

This document is **not** proof that real feed rights, production ingestion, event ranking or script publication are complete.
