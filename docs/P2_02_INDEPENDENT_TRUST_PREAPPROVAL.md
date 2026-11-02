# P2-02 – Independent, preapproved signing trust policy admission

## Security change

The existing external `advance_trust_policy(revision,digest)` high-water function
only rejected _stale revisions_ and _same-revision digest substitution_.
A compromised runtime principal with EXECUTE could still advance to an
**arbitrary higher revision and digest**. High-water monotonicity alone is
therefore **not** an independently approved signing-key trust policy.

The new **independent-authority-only** SQL upgrade
`db/independent-anchor/004_preapproved_trust_policy.sql` fixes that gap:

- An independent non-login authority owner controls
  `vns_source_anchor.trust_policy_approvals`.
- Exactly one SHA-256 digest may be approved for any policy revision.
- `advance_trust_policy` requires a matching **pre-existing approved
  revision/digest**, locked with `FOR SHARE` for the duration of the update.
- The existing monotonic high-water checks still reject stale revisions
  and inconsistent same-revision digests.
- No approval entries or worker grants are inserted automatically.
- The runtime login must have EXECUTE on both anchor advance functions, but
  must not SELECT the high-water or approvals tables, or INSERT, UPDATE or
  DELETE the approvals table. The live identity attestation checks these.
- The runtime cannot promote a new signer merely by changing
  `VNS_FEED_TRUST_POLICY_REVISION` to a larger value.

## Zusätzliche Anmeldungssperre: direkte Schreibrechte und Owner-Mitgliedschaft

Die aktuelle Live-Anmeldung prüft **alle drei unabhängigen Ankertabellen**
auf unzulässige `SELECT`-, `INSERT`-, `UPDATE`-, `DELETE`-,
`TRUNCATE`-, `REFERENCES`- und `TRIGGER`-Berechtigungen.
Das gilt ausdrücklich auch für beide monotonen High-Water-Tabellen;
ein reines `UPDATE` ohne `SELECT` reicht sonst aus, um die
`SECURITY DEFINER`-Funktion zu umgehen.

Zusätzlich verweigert die Live-Anmeldung jede Mitgliedschaft in einer
Eigentümerrolle der drei Ankertabellen oder beider Advance-Funktionen,
auch wenn eine Rolle mit `INHERIT FALSE` aktuell keine Tabellenrechte
erbt. Es genügt nicht, dass die Runtime-Rolle selbst kein Superuser ist:
`SET ROLE` zu einer Autoritätsrolle würde trotzdem den unabhängigen
Anker umgehen.

Der disposable PostgreSQL-17-Test legt deshalb einen **tatsächlichen,
passwortauthentifizierten** Runtime-LOGIN an (nicht bloß
`SET ROLE` als Superuser), testet die minimalen Rechte positiv und
prüft ausdrücklich die negative Aufnahme direkter
`UPDATE`-/`TRUNCATE`-Rechte sowie einer nicht geerbten
Eigentümerrollen-Mitgliedschaft. Nach jedem Negativtest stellt er den
ursprünglichen synthetischen Minimalzustand wieder her.

Die produktive Freigabe bleibt dem unabhängigen Betreiber vorbehalten.
Keine bereits installierten Rechte auf dem VPS werden automatisch
geändert und keine bereits genehmigten Signierschlüssel still ersetzt.

## External-only provisioning and upgrade

This is **not** a regular VideoNews Studio PostgreSQL migration. It belongs
on an independently administered PostgreSQL authority outside the worker,
publisher, main database and their common snapshot/rollback domain.

After independent operator review and **before any live feed process**:

1. Verify the exact release SHA, the current independently pinned public
   Ed25519 key and its digest (using the read-only
   `scripts/p2_01_pinned_trust_policy_report.mjs` helper as supporting
   evidence, not as an authorization).
2. Independently approve the exact positive policy revision and digest.
   Record the evidence and signer fingerprint out of band.
3. Using the **separate authority owner**, install upgrade 004 after
   the already provisioned 003. Own the new approvals table and upgraded
   SECURITY DEFINER function under the independent authority owner.
   **Do not run 004 on the application database.**
4. In a separately reviewed operator session, INSERT the exact approved
   revision/digest into `trust_policy_approvals`. No application or
   feed-worker session may INSERT into this table.
5. Validate that the remote worker LOGIN has only the required schema USAGE
   and the two narrowly scoped EXECUTE privileges. Test negative
   INSERT/UPDATE/DELETE/SELECT access and the refusal of an unapproved
   higher revision or different digest. Preserve independent TLS CA,
   credential custody, audit evidence and restore controls.
6. Only then enable the separately authorized, source-rights-checked
   one-shot feed observer. Do not bootstrap, start a scheduler, or launch
   persistent consumers merely because 004 was installed.

**Upgrade fail-closed behavior:** Existing trust-policy high-water entries
do **not** implicitly authorize themselves. Until an independent operator
seeds the matching approval row, the live worker refuses admission, including
for the existing policy revision. Never weaken the predicate to force a start.

**No automatic key rotation:** The initial live worker still uses exactly
one independently pinned Ed25519 key. Any later rotation requires a
separately approved epoch configuration and a new exact approved digest.

## Testing and limitations

Disposable GitHub PostgreSQL CI applies 001–004 and tests original high-water
behaviors, unapproved higher revisions, mismatched digests, denied runtime
DML/SELECT and concurrent approved-versus-unapproved candidates. Worker
unit tests reject any direct trust approval-table privileges on the actual
authenticated PostgreSQL LOGIN.

CI does not prove custody or operation of an actual external authority;
the user is responsible for VPS deployment and independent anchor
provisioning. No live news source, network egress, provider spend, backups,
Beszel settings or production feed service is changed by this code.
