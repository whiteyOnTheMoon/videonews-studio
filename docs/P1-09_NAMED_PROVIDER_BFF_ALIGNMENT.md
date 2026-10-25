# P1-09 – Gemeinsame persönliche Admin-Berechtigung für KI-Anbieter-BFF

**Nur Git/CI.** Die Next.js-Anbieterroute bleibt GET-only und der
Provider-Schreibvertrag ist weiterhin unmontiert. Kein VPS-Rollout.

Die bestehende schreibgeschützte Anbietervorschau und der vorbereitete
Schreibvertrag verlangen jetzt beide ein `__Host-vns_editor`-Cookie
mit live überprüfter persönlicher Admin-Rolle an `/editor/me`.
Das alte gemeinsame `__Host-vns_session`-Cookie wird nicht
als Berechtigung akzeptiert oder an die Anbieter-API weitergereicht.
Die vorhandene Read-only-Feature-Flag setzt außerdem
`VNS_WEB_EDITOR_AUTH_ENABLED=true` und
`VNS_WEB_ADMIN_JOBS_ENABLED=true` voraus. Ohne Flag bleibt die
GET-Route bei HTTP 404, ohne gültige persönliche Identität bei
HTTP 401/403. Antworten bleiben ohne Secrets und mit `no-store`.

Im unmontierten Schreibvertrag decken zusätzliche Tests falsche,
nichtkanonische und zu große `Content-Length`-Angaben und gesetztes
`Content-Encoding` ab. Ein exakt passender Header mit einem
synthetischen Key bleibt zulässig. Ablehnungen lösen keine
Änderung an der API aus. Die vorhandenen Prüfungen für CSRF, Rollen,
Command-Allowlist, Provider-Deaktivierung und generische Fehler
bleiben erhalten.

**Nicht abgenommen:** Die Tests ersetzen keinen produktiven BFF-POST,
keine KEK-Verwahrung, keinen echten Writer-Login, keine aktive
Datenbankmigration und keinen Restore auf dem VPS. Offsite-Backup,
Beszel-Alarmempfang, echte providerseitige Usage-/Kostenmessung und
ein kostenpflichtiger Anbieter-Rollout bleiben von Issue #9
gesondert abhängig. Es wurden keine echten Keys oder KI-Aufrufe benötigt.
