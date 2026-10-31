# P1-04 — GHCR read-only token custody and on-demand pull (operator runbook)

Status: **repository tooling only, not a VPS migration or rollout authorization**.
Refs #4. Never commit, paste, print, archive, or publish a real access token.

## Existing production constraints

- Repo: `whiteyOnTheMoon/videonews-studio`; personal account packages
  `videonews-studio-web` and `videonews-studio-api`.
- Keep the five existing Compose overlays in their deployed order, retain immutable
  image digests and `pull_policy: never`. This tool does **not** run Compose.
- `secrets/` is excluded by `.gitignore` and `.dockerignore`. Do not disable
  either exclusion.
- Preserve the existing running API, Redis, PostgreSQL and worker. No global Docker
  cleanup, credential logout, image pruning, volume deletion or unattended pulls.

## Identity and token policy

1. Before provisioning a new credential, complete the **read-only VPS inventory**
   and inspect old login/config files by path, permissions and metadata only.
2. In GitHub, under **Settings > Developer settings > Personal access tokens >
   Tokens (classic) > Generate new token (classic)**, create a distinct credential
   named `vns-vps-ghcr-readonly`, with an explicit expiration (recommended 90 days).
   Scope: **`read:packages` only**; do not add `repo`, `workflow`,
   `write:packages`, or `delete:packages`. Verify the chosen GitHub account
   already has read access to BOTH private packages. The token is not constrained
   to just one package: its access is limited by the account's package permissions.
3. In a private interactive SSH session, create the local token file **without
   putting the token in Bash history, process arguments or chat**. Ensure the
   `ap` account, directory owner and permissions are correct. The parent
   `secrets/` directory must already exist, be owned by `ap` and not be
   group/other writable. The dedicated `secrets/ghcr/` directory must be
   `0700`; the token file `0600`, regular, owner `ap`, one hard link
   and no symlinks.
4. Record only the token **name and expiration** separately (no token value).
   Rotate before expiration: create a replacement, validate it against a
   private digest, and then revoke the old credential in GitHub. Do not conclude
   validity from the mere presence of a token entry in GitHub.
5. Review the old tokens by name and permissions in the authorized GitHub
   account. Only revoke a confirmed unused prior token **after** the new pull
   works; revoke immediately if exposed or compromised.

### First-time interactive secure provisioning (only after the inventory)

Run as `ap` in `/home/ap/www/videonews-studio`. This does not contact GHCR,
write to Git or touch Docker:

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  test "$(id -un)" = ap
  python3 - <<'PY'
import getpass, os, re, stat
from pathlib import Path

assert os.isatty(0), "Requires an interactive SSH terminal"
base = Path("secrets")
metadata = base.lstat()
assert stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid()
assert not (stat.S_IMODE(metadata.st_mode) & 0o022), "Unsafe secrets parent"
directory = base / "ghcr"
try:
    directory.mkdir(mode=0o700)
except FileExistsError:
    pass
metadata = directory.lstat()
assert stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid()
assert stat.S_IMODE(metadata.st_mode) == 0o700
target = directory / "readonly_pat"
assert not target.exists() and not target.is_symlink(), "Token already exists; refuse overwrite"
token = getpass.getpass("New GHCR token (input hidden): ")
assert re.fullmatch(r"[A-Za-z0-9_]{30,256}", token), "Invalid token format"
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.write(fd, token.encode("ascii") + b"\n")
    os.fsync(fd)
finally:
    os.close(fd)
del token
print("PASS: GHCR credential stored privately (no value displayed)")
PY
)
```

**Do not run this provisioner if the diagnostic found an existing intended
credential or an unclear state.** Determine which credential is in use first.
The command refuses to replace an existing token; rotation requires a
separately reviewed atomic replacement procedure.

## Non-persistent pull operation

```bash
python3 scripts/vns_ghcr_pull.py \
  'ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:405666fb54e82522181741960233b3ada2763583fa58dd24f401fe68a16dc9e7' \
  'b9cce1d1882d353c033c41e2344aa70e9d2c97d4'
```

The helper:
- Rejects non-allowlisted image repositories, tags, and any unpinned digest.
- Requires strict file ownership/mode and refuses symlinked secret directories
  or token file, and rejects non-GHCR credential requests.
- Creates a private temporary `DOCKER_CONFIG` with only a credential-helper
  reference. A process-scoped `docker-credential-vnsghcr` helper reads the
  token when Docker explicitly asks for `ghcr.io`, without any `docker login`.
- Discards Docker output to avoid exposing sensitive registry errors, removes
  temporary config files on normal completion and catchable interruption.
  On uncatchable SIGKILL, any leftover temporary config is **token-free**.
- Verifies the exact repository digest and `org.opencontainers.image.revision`
  label after pulling. Any failure exits nonzero and does not deploy.
- Does not restart, create, delete or update any container. The previous web
  image remains available for controlled rollback. No shared Docker config
  or other Docker project is touched.

### Acceptance gates

- Confirm successful private image pull and correct revision and repository
  digest; a successful anonymous/public pull is not proof of private access.
- Inspect running container IDs, image IDs and healthchecks before rollout.
- Then, separately, validate the existing Compose file order and runtime
  environment, recreate **only web** with `--no-deps`, and confirm API,
  database, Redis, worker IDs and start times are unchanged. Perform browser
  admin/mobile testing. No rollout approval is implied by the pull script.
- Record release SHA, image digests, operator approval and sanitised evidence.

### Troubleshooting without leaking credentials

- `BLOCKED: GHCR pull/verification failed`: the tool deliberately hides
  registry errors. Check whether the classic token has `read:packages`, has
  not expired/revoked and the personal account can read both private packages;
  check network/DNS and local Docker engine without printing auth/config.
- `Unsafe GHCR secret ...`: inspect `stat`/permissions only; never `cat`
  credentials. Avoid changing permissions of other application secrets.
- For abandoned credential helper directories in `/tmp`, inspect their
  ownership/content **structure only** before cleanup. This tool does not
  persist token bytes there and does not call global cleanup commands.

## Security boundaries

A classic token is tied to its GitHub principal and could read other packages
that account can access. A truly package-isolated machine identity requires
separately granted package access, not merely a narrower classic token scope.
Protect the `ap` Unix account and do not paste diagnostic output from
`docker config` or the credential helper's private protocol into chat.
