# P2-02 — Redis 8 user-systemd unpause-watchdog preparation (code only)

## Grounded production state

At `main=1d8b8b8c97360b029331715072ad0ee1b9e7dac4`,
the VPS read-only checks, reported by the operator, confirmed:

- `ap` is UID 1000 with Docker daemon access;
- `systemctl --user` is available;
- `loginctl --no-ask-password enable-linger` succeeded, and
  `Linger=yes` was verified;
- `videonews-studio-redis-1` is running and not paused;
- the P1 worker is running and not paused;
- no production AOF copy, replay, Redis restart or container pause occurred.

The project has an active source Redis volume
`videonews-studio_redis_p109_restored` and a retained historical
`videonews-studio_redis_data`. Neither may be overwritten.

## Scope of this PR

`p2_02_redis8_unpause_watchdog_policy.py` is an **import-only**
policy primitive. It has NO CLI and NO systemd/Docker operations by itself.
A separately reviewed caller must supply a Docker-inspect function and an
unpause-only function. Before unpausing it verifies the container's full
64-hex ID, exact name, pinned Redis image reference and image ID, Docker
Compose project/service labels, sole `/data` mount type and source
identity, lack of host-published ports, and running/paused state. It
re-checks all these invariants after unpause. A non-paused container is
left unchanged.

A production-named target is restricted to the exact pinned image
digest, production project/service and active restored Docker volume.
The module cannot pause, restart, recreate, stop or delete a container.

The unit tests contain only fabricated inspection data. A second
GitHub-Actions test starts **one disposable synthetic Redis 8.4.8**
without a network or host ports, pauses it, verifies that a forged
container ID is rejected, then unpauses precisely the observed
container ID and verifies it is running. The test does not see the VPS
or its volumes, users or credentials.

## Still missing — PRODUCTION FAIL CLOSED

1. **Test systemd-user timer independently** on a harmless disposable
   target, including armed state, delayed firing, exit-code and timer
   lifecycle; demonstrate that an SSH logout does not cancel the
   timer. Linger alone does not prove this.
2. Build a *separate* watchdog runner: local Unix Docker socket only,
   short command timeouts, exact expected container ID/image ID/volume
   custody, bounded lease and initial source identity witness.
   Schedule and prove the watchdog **before** any possible pause.
3. Test worst-case interrupted operator (including lost shell/SIGKILL),
   missing Docker daemon, systemd-user failure, repeat/misfire,
   container recreation or changed volume, and post-unpause P1
   reconnect/recovery behavior.
4. The short capture must have a strict, measured wall-clock bound
   and an independent out-of-process fallback. The CI `finally`
   cleanup is NOT sufficient.
5. Before live execution, revalidate AOF source, queue and PostgreSQL
   state, disk headroom, exact main release and absence of AOF
   rewrite activity. Independently hold private archive, manifest
   integrity inventory, trusted provenance and an off-host copy.
6. Replay a production-derived independent copy on a separate
   networkless Redis 8.4.8 instance, then compare redacted P1/P2
   structures and ACL health. Only a verified restore can support
   a separate maintenance decision.

**STATUS: WATCHDOG POLICY + SYNTHETIC CI ONLY. NO PRODUCTION
WATCHDOG INSTALLED, NO PAUSE AUTHORIZED, NO BACKUP OR RESTORE PROOF.**

Read systemd `loginctl` and `systemd-run` documentation and Docker
`pause`/`unpause` documentation before designing the separate
production runner.


## Subsequent evidence and isolated VPS systemd rehearsal

The operator subsequently verified a persistent systemd-user test timer:
`LastTriggerUSec=2026-11-11 20:30:22 UTC`,
`PROOF_EXECUTED=true`, `LINGER=yes`, private mode-0600 proof,
and successful service start/exit journal entries. The harmless service,
timer, and proof were then removed with `TIMER_CLEANUP=PASS`; Linger
remained enabled. **That proof did not record the absence of other active
SSH sessions**, so the strict zero-session claim is still open.

`p2_02_redis8_synthetic_watchdog_vps.py` is a narrow, unpause-only
wrapper around the policy. It insists on the **fixed lab name**
`vns-p2-redis-watchdog-lab-20261111`, `none` networking, Redis image
digest, synthetic Compose label, read-only root filesystem, non-root UID,
all capabilities dropped and an exact disposable bind mount inside
`/run/user/1000`. It refuses a production container (including if a
production ID is passed), never pauses a container and never restarts,
removes or recreates Docker objects.

`p2_02_redis8_watchdog_vps_lab.sh` is a separate, explicit
operator-invoked test. With `VNS_P2_LAB_SHA` set to the **exact current
clean main commit**, `--prepare` creates the uniquely named synthetic
Redis 8 lab with AOF disabled, arms its user-systemd timer for 120
seconds, verifies that it is armed, and **only then** pauses that lab
container. The prepare process exits without unpausing. The timer's
one-shot service invokes only the above exact-ID release helper.
`--verify` is read-only and requires the systemd service actually
started, its result was successful, and the synthetic Redis is running.
`--cleanup` releases the exact lab if necessary, removes only the lab
container, its two generated user-unit files and its disposable
directory. All modes refuse dirty/mismatched Git or a missing Linger.

The operator MUST run the prepare, verify and cleanup stages separately,
review the outputs, and stop if any REFUSED appears. Never copy a
synthetic lab `docker pause` command onto the production container.

This smoke test **does not establish** a crash-proof production watchdog:
a reboot, Docker-daemon outage longer than the retry window, changed
container identity, disk exhaustion, systemd-user failure, and
production BullMQ behavior have not been verified. It also does not
establish an independently stored and consistency-proven backup. An
out-of-band recovery path remains necessary for any production
maintenance decision.
