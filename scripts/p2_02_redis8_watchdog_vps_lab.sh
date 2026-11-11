#!/usr/bin/env bash
# P2-02: bounded synthetic-only lab: arm watchdog before pausing disposable Redis.
# NEVER selects, pauses, restarts, or deletes the production Redis.
set -euo pipefail
umask 077

readonly SHA="$VNS_P2_LAB_SHA"
readonly ROOT="/home/ap/www/videonews-studio"
readonly NAME="vns-p2-redis-watchdog-lab-20261111"
readonly DATA="/run/user/1000/$NAME-data"
readonly IDENTITY="$DATA/identity.txt"
readonly PAUSE_MARKER="$DATA/pause-marker.txt"
readonly UNIT="$NAME"
readonly SERVICE="$HOME/.config/systemd/user/$UNIT.service"
readonly TIMER="$HOME/.config/systemd/user/$UNIT.timer"
readonly RUNNER="$ROOT/scripts/p2_02_redis8_synthetic_watchdog_vps.py"
readonly IMAGE="redis:8.4.8-alpine@sha256:d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"

fail() { echo "REFUSED: synthetic VPS watchdog lab precondition" >&2; exit 1; }
[[ $# -eq 1 && "$1" =~ ^--(prepare|verify|cleanup)$ ]] || fail
readonly MODE="$1"
[[ "$(id -un)" == ap && "$(id -u)" == 1000 ]] || fail
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || fail
cd "$ROOT"
[[ "$(git --no-optional-locks rev-parse HEAD)" == "$SHA" ]] || fail
[[ "$(git --no-optional-locks branch --show-current)" == main ]] || fail
[[ -z "$(git --no-optional-locks status --porcelain)" ]] || fail
[[ "$(loginctl show-user ap -p Linger --value)" == yes ]] || fail
systemctl --user show -p Version --value >/dev/null
command -v docker >/dev/null
[[ -f "$RUNNER" && ! -L "$RUNNER" ]] || fail

read_identity() {
  [[ -d "$DATA" && ! -L "$DATA" ]] || fail
  [[ "$(stat -c '%u:%a' "$DATA")" == 1000:700 ]] || fail
  [[ -f "$IDENTITY" && ! -L "$IDENTITY" ]] || fail
  [[ "$(stat -c '%u:%a' "$IDENTITY")" == 1000:600 ]] || fail
  [[ "$(wc -l < "$IDENTITY")" -eq 2 ]] || fail
  CID="$(sed -n '1p' "$IDENTITY")"
  IMGID="$(sed -n '2p' "$IDENTITY")"
  [[ "$CID" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$IMGID" =~ ^sha256:[a-f0-9]{64}$ ]] || fail
}
policy_check() {
  python3 "$RUNNER" --check --expected-sha "$SHA" \
    --container-id "$CID" --image-id "$IMGID"
}
policy_release() {
  python3 "$RUNNER" --release --expected-sha "$SHA" \
    --container-id "$CID" --image-id "$IMGID"
}

case "$MODE" in
  --prepare)
    [[ ! -e "$SERVICE" && ! -L "$SERVICE" ]] || fail
    [[ ! -e "$TIMER" && ! -L "$TIMER" ]] || fail
    [[ ! -e "$DATA" && ! -L "$DATA" ]] || fail
    if docker container inspect "$NAME" >/dev/null 2>&1; then fail; fi
    docker image inspect "$IMAGE" >/dev/null
    install -d -m 700 "$DATA"
    install -d -m 700 "$HOME/.config/systemd/user"

    CID="$(docker run --pull=never --rm -d --name "$NAME" \
      --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --user 1000:1000 --memory 144m --memory-swap 144m \
      --cpus 0.3 --pids-limit 64 \
      --tmpfs /tmp:rw,nosuid,noexec,size=8m \
      --label com.docker.compose.project=vns-p2-synthetic \
      --label com.docker.compose.service=redis \
      --mount "type=bind,src=$DATA,dst=/data" \
      "$IMAGE" redis-server --protected-mode yes \
      --bind 127.0.0.1 --appendonly no --save "" --dir /data \
      --maxmemory 96mb --maxmemory-policy noeviction)"
    [[ "$CID" =~ ^[a-f0-9]{64}$ ]] || fail
    IMGID="$(docker inspect --format '{{.Image}}' "$CID")"
    [[ "$IMGID" =~ ^sha256:[a-f0-9]{64}$ ]] || fail
    printf '%s\n%s\n' "$CID" "$IMGID" > "$IDENTITY"
    chmod 600 "$IDENTITY"

    READY=false
    for _ in {1..30}; do
      if [[ "$(docker exec "$CID" redis-cli ping 2>/dev/null || true)" == PONG ]]; then
        READY=true
        break
      fi
      sleep 1
    done
    [[ "$READY" == true ]] || fail
    policy_check >/dev/null

    cat > "$SERVICE" <<EOF
[Unit]
Description=VNS synthetic Redis exact-ID unpause lab service
StartLimitIntervalSec=60s
StartLimitBurst=6

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $RUNNER --release --expected-sha $SHA --container-id $CID --image-id $IMGID
Restart=on-failure
RestartSec=3s
TimeoutStartSec=30s
EOF
    cat > "$TIMER" <<EOF
[Unit]
Description=VNS independent synthetic Redis unpause lab timer

[Timer]
OnActiveSec=45s
OnUnitInactiveSec=15s
AccuracySec=1s
Unit=$UNIT.service
EOF
    chmod 600 "$SERVICE" "$TIMER"
    systemctl --user daemon-reload
    systemctl --user start "$UNIT.timer"
    systemctl --user is-active --quiet "$UNIT.timer"
    NEXT="$(systemctl --user show "$UNIT.timer" \
      -p NextElapseUSecMonotonic --value)"
    [[ -n "$NEXT" && "$NEXT" != infinity ]] || fail
    [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$CID")" == "true|false" ]] || fail
    policy_check >/dev/null
    # The independent user-systemd timer is armed BEFORE pausing the lab.
    docker pause "$CID" >/dev/null
    [[ "$(docker inspect --format '{{.State.Paused}}' "$CID")" == true ]] || fail
    [[ ! -e "$PAUSE_MARKER" && ! -L "$PAUSE_MARKER" ]] || fail
    date -u +%s > "$PAUSE_MARKER"
    chmod 600 "$PAUSE_MARKER"
    echo "LAB_TIMER_ARMED=true"
    echo "LAB_CONTAINER_PAUSED=true"
    echo "LAB_FIRST_RELEASE_DELAY_SECONDS=45"
    echo "LAB_RECHECK_INTERVAL_SECONDS=15"
    echo "PRODUCTION_REDIS_TOUCHED=false"
    echo "OPERATOR_EXITS_WITHOUT_UNPAUSING=true"
    ;;
  --verify)
    read_identity
    policy_check
    [[ "$(docker inspect --format '{{.State.Paused}}' "$CID")" == false ]] || fail
    [[ -f "$PAUSE_MARKER" && ! -L "$PAUSE_MARKER" ]] || fail
    [[ "$(stat -c '%u:%a' "$PAUSE_MARKER")" == 1000:600 ]] || fail
    PAUSED_AT="$(cat "$PAUSE_MARKER")"
    [[ "$PAUSED_AT" =~ ^[0-9]{10}$ ]] || fail
    [[ "$(systemctl --user show "$UNIT.service" -p Result --value)" == success ]] || fail
    LAST_STARTED="$(systemctl --user show "$UNIT.service" \
      -p ExecMainStartTimestamp --value)"
    [[ -n "$LAST_STARTED" ]] || fail
    STARTED_EPOCH="$(date -u -d "$LAST_STARTED" +%s)"
    (( STARTED_EPOCH > PAUSED_AT )) || fail
    journalctl --user -u "$UNIT.service" --since "@$PAUSED_AT" \
      --no-pager --output=cat | grep -Fxq "LAB_UNPAUSE_ATTEMPTED=true" || fail
    [[ -n "$(systemctl --user show "$UNIT.timer" \
      -p LastTriggerUSec --value)" ]] || fail
    echo "LAB_INDEPENDENT_TIMER_RELEASE=PASS"
    echo "LAB_REDIS_RUNNING=true"
    echo "PRODUCTION_REDIS_TOUCHED=false"
    ;;
  --cleanup)
    read_identity
    policy_check >/dev/null
    [[ -f "$SERVICE" && -f "$TIMER" && ! -L "$SERVICE" && ! -L "$TIMER" ]] || fail
    # The independent timer must stay armed until the exact synthetic
    # target is confirmed running. If this operator is interrupted before
    # release, the timer remains available to recover the lab container.
    policy_release >/dev/null
    [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$CID")" == "true|false" ]] || fail
    policy_check >/dev/null
    systemctl --user stop "$UNIT.timer"
    systemctl --user stop "$UNIT.service" || true
    docker rm -f "$CID" >/dev/null
    rm -- "$SERVICE" "$TIMER" "$IDENTITY" "$PAUSE_MARKER"
    systemctl --user daemon-reload
    rmdir -- "$DATA"
    echo "LAB_CLEANUP=PASS"
    echo "USER_LINGER_UNCHANGED=true"
    echo "PRODUCTION_REDIS_TOUCHED=false"
    ;;
esac
