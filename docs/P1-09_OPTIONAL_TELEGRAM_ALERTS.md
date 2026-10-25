# P1-09 – Optional Telegram warning delivery (NOT enabled)

Refs #9. This change only adds an optional, unconnected notification client.
The existing live 15-minute `vns-disk-watch.timer` and local journal remain
unchanged. **No network request, credentials, new timer or VPS modification
is part of this PR.** This does not close P1-09.

## Why an optional delivery adapter?

The headless VPS already records disk WARN/CRITICAL/UNKNOWN states locally;
those events do not reach an operator remotely. The Telegram Bot API is one
possible notification transport, not an operator-approved preference.
Choosing Telegram, email or another destination is a separate decision.

## Security and behavior

`scripts/p1_09_telegram_alert.py` requires explicit `--send` before any
outbound request. `--check-config` only validates local files, without
network access or writing state. Running without either option is refused.

The implementation uses the fixed HTTPS endpoint `api.telegram.org`, a
standard-library TLS certificate verifier and bounded HTTP responses.
Only `VideoNews Studio disk STATUS - free: N GiB / N%` (or `disk metrics
unavailable`) is sent. There is no hostname, login, source text, password,
SQL data, API usage or media in the notification. Telegram as the provider
necessarily receives this limited message and chat ID.

The only supported credential files, **if separately configured**, are:

- `/home/ap/.config/videonews-studio/disk-alert/telegram_token`
- `/home/ap/.config/videonews-studio/disk-alert/telegram_chat_id`

The directory must be owned by the invoking UID and be mode 0700.
Both regular files must be owned by that UID and be mode 0600;
symlinks, hardlinks, excessive sizes and malformed values are rejected.
Never post a bot token or chat ID into ChatGPT, GitHub, terminal output
or command arguments. No token is included in the repository.

Alert state uses a private directory:
`/home/ap/.local/state/videonews-studio/` (mode 0700), with a
single 0600 JSON file (level, last successful notification time).
Concurrent sends use an exclusive file lock and state updates are atomic.

- Initial healthy state: no outbound notification.
- Entering WARN, CRITICAL or UNKNOWN: send once on change.
- Persisting same unhealthy level: repeat no more than every six hours.
- Returning to OK after an alert: send one recovery notice.
- Failed delivery: leave previous successful state unchanged to retry later.

Real notifications only begin **after** a recipient/channel is chosen, a
bot is configured privately and a separately reviewed scheduler is
installed and activated. No setup or message has been attempted here.

The existing running disk-watch service must not be replaced implicitly.
A later integration must use its own explicit opt-in systemd unit or an
independently reviewed path, preserve the working local checks, and test a
real delivery and an undeliverable-message failure without printing secrets.

## Limitations

The in-memory tests use a fake sender and synthetic disk readings; no
Telegram account or network is contacted in CI. A provider may temporarily
reject requests or be unavailable; the local systemd journal remains the
primary evidence source. Periodic outgoing network delivery may depend
on future operator networking and secrets configuration.

Independent offsite backup/restore, durable provider token accounting and
actual end-to-end operator notification are still open acceptance gates.
