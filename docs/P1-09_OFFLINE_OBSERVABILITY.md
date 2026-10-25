# P1-09 — First offline observability slice (no production activation)

Refs #9. This is **partial implementation**, not completed P1-09 acceptance.

## Disk pressure policy — read-only

`scripts/p1_09_disk_watch.py` checks the filesystem holding the VideoNews
checkout with only Python standard-library calls. It does not inspect file
contents, Redis, Docker, secrets, or the network.

- OK: at least 20 GiB **and** at least 15% free.
- WARN (exit 2): below 20 GiB **or** below 15% free.
- CRITICAL (exit 3): below 10 GiB **or** below 8% free.
- UNKNOWN (exit 4): measurements unavailable; never silently reports OK.

Optional read-only command after operator approval:

```sh
python3 scripts/p1_09_disk_watch.py
```

The script emits one bounded status line. **No timer, cron job, webhook,
email, alert destination, Docker service or cost-bearing provider is installed
or activated.** Automatic alerts require separately approved scheduling and
delivery. There is no Docker prune/delete/volume operation.

## Explicit per-job token/price calculation (offline estimate)

The existing PostgreSQL schema contains `vns.costs`, but the currently
running worker executes only harmless probes. There is no provider API
integration or real usage data to account for yet.

`scripts/p1_09_cost_model.py` takes a strictly delimited JSON record with
`jobId`, `requestId`, `provider`, `model`, `inputTokens`, `outputTokens`,
`inputMicroUsdPerMillion` and `outputMicroUsdPerMillion`. Usage counters and
both USD micro-unit rates must be supplied by a future approved adapter.
Rates are never guessed or fetched. 2,000,000 micro-USD per million tokens
corresponds to USD 2 per million tokens.

Synthetic example (contains no actual provider usage):

```sh
printf '%s\n' '{"jobId":"b274db39-cfd5-46bf-8438-27557b89201a","requestId":"ci_request_000001","provider":"fixture","model":"ci-model-v1","inputTokens":1000,"outputTokens":500,"inputMicroUsdPerMillion":2000000,"outputMicroUsdPerMillion":8000000}' | python3 scripts/p1_09_cost_model.py --calculate
```

`--summarize` accepts an array of up to 100 records, yields deterministic
per-job summaries and deduplicates identical `(jobId, requestId)` events.
Conflicting duplicates are rejected. The calculation uses exact integer
arithmetic; output always includes `"estimated":true` and **must not be
represented as a real invoice, committed SQL transaction or actual charge**.
No prompts, API credentials or freeform source contents are accepted.

**Not yet present:** live provider usage ingestion, durable authorized
storage into `vns.costs`, approved rates, hard spending quotas, a dashboard
and alert delivery. Those require separately tested integrations and
operator approval. No PostgreSQL schema, runtime permissions or running
containers are changed.

## CI cost and recovery boundary

The workflow runs one Python standard-library test job with a three-minute
limit and cancels superseded PR runs. No Docker images, paid SaaS, or test
databases are started. Existing disposable restore tests are not an off-VPS
production backup or a measured recovery target. P1-09 **remains open**.
