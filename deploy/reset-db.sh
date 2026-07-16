#!/usr/bin/env bash
# Wipe quorum's stored state and let the relay rebuild an empty schema.
#
# The relay recreates all tables on boot (CREATE TABLE IF NOT EXISTS in
# relay/src/pg.rs), so a reset just means emptying Postgres and restarting it.
# This does it IN PLACE (DROP SCHEMA public CASCADE) so it works no matter how
# you deployed — sslip.io, a real domain, or the self-signed IP overlay — and
# never touches Caddy's volume, so your TLS certificate survives.
#
#   sudo ./deploy/reset-db.sh            # wipe the database (keep attachments)
#   sudo ./deploy/reset-db.sh --all      # also delete stored attachments (blobs)
#   sudo ./deploy/reset-db.sh --yes      # skip the confirmation prompt
#   sudo ./deploy/reset-db.sh --project quorum   # disambiguate if >1 stack runs
#
# Erases: accounts/vaults, pinned identity keys (TOFU), messages, groups,
# invites, push subscriptions (and, with --all, uploaded attachments).
# Existing browser clients keep local keys — have users re-onboard for a truly
# clean slate.

set -euo pipefail

WIPE_BLOBS=0
ASSUME_YES=0
PROJECT=""

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--all|--blobs) WIPE_BLOBS=1; shift ;;
		-y|--yes)      ASSUME_YES=1; shift ;;
		--project)     PROJECT="${2:?--project needs a value}"; shift 2 ;;
		-h|--help)     usage 0 ;;
		*) echo "unknown option: $1" >&2; usage 1 ;;
	esac
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx  \033[0m %s\n' "$*" >&2; exit 1; }

# docker needs root; use sudo only when we aren't already root
DOCKER="docker"
[ "$(id -u)" -ne 0 ] && DOCKER="sudo docker"

command -v docker >/dev/null 2>&1 || die "docker not found."

# --- locate the running containers by compose label ------------------------
find_cid() { # $1 = compose service name
	local filters=(--filter "label=com.docker.compose.service=$1" --filter "status=running")
	[ -n "$PROJECT" ] && filters+=(--filter "label=com.docker.compose.project=$PROJECT")
	$DOCKER ps -q "${filters[@]}"
}

DB_CID="$(find_cid db)"
[ -z "$DB_CID" ] && die "No running 'db' (postgres) container found. Start the stack first, or pass --project."
if [ "$(printf '%s\n' "$DB_CID" | grep -c .)" -gt 1 ]; then
	die "Multiple 'db' containers are running — pass --project <name> to pick one."
fi

RELAY_CID="$(find_cid quorum)"
[ -z "$RELAY_CID" ] && warn "No running 'quorum' (relay) container found; will skip the restart."

# postgres credentials come straight from the container's environment
PGUSER="$($DOCKER exec "$DB_CID" printenv POSTGRES_USER 2>/dev/null || true)"; PGUSER="${PGUSER:-quorum}"
PGDB="$($DOCKER exec "$DB_CID" printenv POSTGRES_DB 2>/dev/null || true)";     PGDB="${PGDB:-quorum}"

# --- confirm ---------------------------------------------------------------
log "This will ERASE the '$PGDB' database (accounts, keys, messages, groups, invites, push subs)."
[ "$WIPE_BLOBS" -eq 1 ] && log "It will ALSO delete all stored attachments (blobs)."
log "Your TLS certificate and domain config are NOT affected."
if [ "$ASSUME_YES" -ne 1 ]; then
	printf 'Type "reset" to continue: '
	read -r reply
	[ "$reply" = "reset" ] || die "Aborted."
fi

# --- wipe the database (schema drop → relay rebuilds it) -------------------
log "Dropping and recreating schema in '$PGDB'…"
$DOCKER exec "$DB_CID" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
	-c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# --- optionally wipe attachments -------------------------------------------
if [ "$WIPE_BLOBS" -eq 1 ]; then
	if [ -n "$RELAY_CID" ]; then
		log "Deleting stored attachments…"
		# BLOB_DIR defaults to /data/blobs inside the relay container.
		BLOB_DIR="$($DOCKER exec "$RELAY_CID" printenv BLOB_DIR 2>/dev/null || true)"; BLOB_DIR="${BLOB_DIR:-/data/blobs}"
		$DOCKER exec "$RELAY_CID" sh -c "rm -rf '$BLOB_DIR'/* '$BLOB_DIR'/.[!.]* 2>/dev/null || true"
	else
		warn "Relay container not running — cannot clear blobs. Skipped."
	fi
fi

# --- restart the relay so it recreates the empty tables --------------------
if [ -n "$RELAY_CID" ]; then
	log "Restarting the relay to rebuild the schema…"
	$DOCKER restart "$RELAY_CID" >/dev/null
fi

log "Done. The database is empty and the relay has rebuilt its tables."
warn "Existing browser clients still hold local keys/group state — have users re-onboard for a clean slate."
