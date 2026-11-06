# P2-02 NASA: read-only queue and slot preflight

**Code-only, dormant, no runtime authorization.** This helper is only a
bounded, metadata-free snapshot of the **existing private** Redis queue.
It is not a sign-off to fetch NASA, write candidates, replay jobs, reset
leases, refresh signed source checkpoints, start a container or publish.

## Prior operator evidence

The operator's 2026-11-06 read-only VPS inspection on pinned
`5630a9dce503adac230273608b5c7a06e8b11bb6` confirmed:

- independently signed publisher stage revision **10/10**;
- PostgreSQL registry and host approval revision **10/10**;
- exactly one approved `nasa_news` RSS/metadata-only entry with explicit
  same-host `www.nasa.gov` feed URL and current host-grant audit;
- NASA poll lease present, SQL-clock eligible;
- **zero** NASA candidates; ten historical NOAA mapped events, all
  beyond the current editorial profile's 24-hour candidate-age window;
- no feed or database change during those reads.

The previously run stage `--verify` compares the independently signed
publisher export with the staging file. **It does not by itself prove**
the worker inbox/checkpoint/SQL high-water anchor byte equality. Those
must be checked separately before any operational approval.

## New queue inspector

`sudo python3 scripts/p2_02_nasa_queue_readonly_preflight.py
--expected-sha <reviewed SHA>`

The operator must be root for this protected-secret *read*. It requires
a SHA-pinned clean `main` checkout and a verified, healthy existing
internal Compose Redis without host port mappings. The existing
`p2_02_live_redis_acl_readonly.py` performs all Redis user/password
custody, protected-file permissions, ACL WHOAMI and P1-keyspace refusal
checks. No passwords appear in process arguments, environment,
stdout/stderr or stored files.

The additional helper sends only `AUTH`, `PING`, `ACL WHOAMI`,
`LLEN`, `ZCARD`, `SCARD` and `EXISTS` with hard-coded
`bull:vns:feed:vns-feed-poll:` keys. It reads bounded numbers of
**waiting, active, paused, delayed, prioritized, waiting-children,
stalled, failed, completed and repeat schedule** entries, plus whether
the previous/current 15-minute slot's deterministic BullMQ job key exists.
It does **not** enumerate arbitrary keys, read individual job IDs or
payloads, change a job's state, acknowledge a delivery, call a Lua
script, connect to PostgreSQL or contact an external website.

A running/created feed-side Docker Compose service, a pending/active
job, a repeat schedule or an already existing current-slot job causes
`status=blocked`. Past completed/failed counts and the prior-slot
existence flag are reported, **not modified**. `status=reviewable`
means only that the observed snapshot has no obvious queue-state
conflict; historical failures still require human inspection. The
instantaneous view can race a concurrent enqueue; it is never a lock or
authorization token.

The helper never starts the P2 canary and cannot demonstrate source
rights, complete signed inbox/SQL anchor parity, current feed content,
successful projection, two-source independence, quality-weighted
ranking, Admin visibility or publication readiness. Another independent
approval is required for each external NASA read or SQL/Redis write.

## CI

Synthetic tests prove refused mutation commands and out-of-prefix
keys, malformed integer responses, exact bounded commands, strict
authentication, redacted reports, no service conflicts, historical
failed-job preservation and correct blocking of a current-slot job.
Only the actual operator may run the live helper; GitHub CI never
connects to a production Redis or reads production credentials.
