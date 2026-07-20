#!/usr/bin/env bash
# Deploy the quorum stack. Runs ON THE SERVER — the GitHub Actions workflow
# (.github/workflows/deploy.yml) pipes this in over SSH.
#
# Build-on-server: pull main, rebuild the relay+client image, health-check the
# public site, and roll back to the previous commit if it doesn't come up.
#
# The image build is heavy (Rust release + wasm-pack + Node client). A FAILED
# build leaves the currently-running container untouched, so a broken build
# cannot take the site down — only a build that succeeds but runs unhealthy
# triggers the rollback below.
set -euo pipefail

REPO_DIR="$HOME/discord"
URL="https://quorum.mich312.com/"
cd "$REPO_DIR"

# The exact overlay set the stack runs with: base + edge (external TLS proxy,
# no built-in Caddy) + turn (coturn). deploy/.env holds CADDY_DOMAIN/VAPID/TURN.
compose() {
  docker compose --env-file deploy/.env \
    -f docker-compose.yml \
    -f deploy/docker-compose.edge.yml \
    -f deploy/docker-compose.turn.yml "$@"
}

healthy() {
  sleep 3   # give the relay a moment to boot + reach postgres
  for _ in $(seq 1 18); do   # ~90s
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL") || code=000
    echo "  $URL -> $code"
    case "$code" in [1-4][0-9][0-9]) return 0 ;; esac   # 000/5xx (e.g. 502) = down
    sleep 5
  done
  return 1
}

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
