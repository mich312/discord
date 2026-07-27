#!/usr/bin/env bash
# Deploy the quorum stack. Runs ON THE SERVER — the GitHub Actions workflow
# (.github/workflows/deploy.yml) pipes this in over SSH.
#
# Two modes, chosen by whether QUORUM_IMAGE is set:
#
#   image mode (what CI does) — the image was built and pushed by the
#   workflow, so deploying is `pull` + `up -d`. Rollback re-points the tag and
#   restarts: seconds, and it cannot fail the way a build can.
#
#   build mode (fallback) — no QUORUM_IMAGE, so build on the server as before.
#   Kept deliberately: a registry outage, a missing token, or a hand-run
#   deploy must not leave the operator with no way to ship.
#
# Why image mode matters. Rollback used to be `git reset --hard` plus a full
# Rust + wasm-pack + Node rebuild on the production box, so the recovery path
# was itself a multi-minute build that could fail — the worst possible
# property for a recovery path, because you only ever run it when something is
# already wrong.
set -euo pipefail

REPO_DIR="$HOME/discord"
# No trailing slash. Paths below are appended directly, and the relay's router
# (axum/matchit) does not collapse "//" — a base of ".../" once produced
# "//healthz", which matches no route and falls through to the static-file
# fallback as a 404. That 404ed every deploy AND every rollback.
URL="https://quorum.mich312.com"
HEALTH_URL="${URL%/}/healthz"
# Survives across deploys, so a rollback still knows what was last known good
# even if the current containers are gone.
STATE_FILE="$REPO_DIR/deploy/.last-good-image"
cd "$REPO_DIR"

# The exact overlay set the stack runs with: base + edge (external TLS proxy,
# no built-in Caddy) + turn (coturn). deploy/.env holds CADDY_DOMAIN/VAPID/TURN.
compose() {
  docker compose --env-file deploy/.env \
    -f docker-compose.yml \
    -f deploy/docker-compose.edge.yml \
    -f deploy/docker-compose.turn.yml "$@"
}

# Health means "the relay is up AND can reach its database". This used to
# fetch "$URL" (the client's index.html, served by ServeDir) and accept any
# 1xx-4xx — so a 404, a 403, or a relay with a dead Postgres behind it all
# passed, and a broken deploy was never rolled back.
healthy() {
  sleep 3   # give the relay a moment to boot + reach postgres
  for _ in $(seq 1 18); do   # ~90s
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL") || code=000
    echo "  $HEALTH_URL -> $code"
    case "$code" in 2[0-9][0-9]) return 0 ;; esac   # only a real 2xx is healthy
    sleep 5
  done
  return 1
}

# What is serving right now. Preferred over the state file because it is the
# ground truth; the file covers a first run or a host whose containers are gone.
running_image() {
  compose ps --format '{{.Image}}' quorum 2>/dev/null | head -1
}

if [ -n "${QUORUM_IMAGE:-}" ]; then
  # ---------------------------------------------------------------- image --
  PREV_IMAGE="$(running_image)"
  if [ -z "$PREV_IMAGE" ] && [ -f "$STATE_FILE" ]; then
    PREV_IMAGE="$(cat "$STATE_FILE")"
  fi
  echo "deploying image $QUORUM_IMAGE (currently ${PREV_IMAGE:-none})"

  # The compose files still come from git, so keep the checkout in step —
  # but nothing is *built* from it in this mode.
  git fetch origin --quiet
  git reset --hard origin/main

  export QUORUM_IMAGE
  compose pull quorum
  compose up -d --no-build

  echo "health-checking $URL ..."
  if healthy; then
    echo "✅ deploy OK: $QUORUM_IMAGE"
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '%s\n' "$QUORUM_IMAGE" > "$STATE_FILE"
    exit 0
  fi

  if [ -z "$PREV_IMAGE" ]; then
    echo "❌ unhealthy, and there is no previous image to fall back to — needs a look"
    exit 1
  fi

  echo "❌ unhealthy — rolling back to $PREV_IMAGE"
  # No build, no compile, no fetch of source: the previous image is already on
  # this host, so this is a restart.
  QUORUM_IMAGE="$PREV_IMAGE" compose up -d --no-build
  if healthy; then
    echo "rolled back to $PREV_IMAGE"
  else
    echo "rollback ALSO unhealthy — needs a look"
  fi
  exit 1
fi

# ------------------------------------------------------------------ build --
# The image build is heavy (Rust release + wasm-pack + Node client). A FAILED
# build leaves the currently-running container untouched, so a broken build
# cannot take the site down — only a build that succeeds but runs unhealthy
# triggers the rollback below.
echo "QUORUM_IMAGE not set — building on the server (slower, and rollback rebuilds too)"

PREV=$(git rev-parse HEAD)
git fetch origin --quiet
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
echo "deploying ${PREV:0:8} -> ${NEW:0:8}"

compose up -d --build

echo "health-checking $URL ..."
if healthy; then
  echo "✅ deploy OK: ${NEW:0:8}"
  exit 0
fi

echo "❌ unhealthy — rolling back to ${PREV:0:8}"
git reset --hard "$PREV"
compose up -d --build
if healthy; then echo "rolled back to ${PREV:0:8}"; else echo "rollback ALSO unhealthy — needs a look"; fi
exit 1
