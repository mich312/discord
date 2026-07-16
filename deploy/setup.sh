#!/usr/bin/env bash
# One-shot HTTPS deploy for quorum on a fresh VM (Hetzner or anywhere).
#
# Defaults to the recommended path: front the relay with a free
# <ip>.sslip.io hostname so Caddy gets a real, auto-renewing Let's Encrypt
# certificate (no browser warning, passkeys work). Pass --domain to use your
# own hostname, or --self-signed to serve the raw IP with a self-signed cert
# (browser warning + passkeys disabled).
#
# Run it from a clone of this repo:
#
#   sudo ./deploy/setup.sh                 # auto-detect IP, use <ip>.sslip.io
#   sudo ./deploy/setup.sh --firewall      # also open 22/80/443 via ufw
#   sudo ./deploy/setup.sh --domain chat.example.org
#   sudo ./deploy/setup.sh --self-signed --ip 159.69.153.29
#   sudo ./deploy/setup.sh --turn --firewall   # also run coturn for voice (opens TURN ports)
#
# Safe to re-run: it rewrites deploy/.env (backing up any existing one) and
# recreates the containers.

set -euo pipefail

# --- locate the repo -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# --- defaults / args -------------------------------------------------------
IP=""
DOMAIN=""
SELF_SIGNED=0
DO_FIREWALL=0
NO_INSTALL=0
VAPID="${VAPID_PRIVATE_KEY:-}"
TURN=0
TURN_SECRET_VAL="${TURN_SECRET:-}"

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--ip)          IP="${2:?--ip needs a value}"; shift 2 ;;
		--domain)      DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
		--self-signed) SELF_SIGNED=1; shift ;;
		--firewall)    DO_FIREWALL=1; shift ;;
		--turn)        TURN=1; shift ;;
		--turn-secret) TURN_SECRET_VAL="${2:?--turn-secret needs a value}"; shift 2 ;;
		--vapid)       VAPID="${2:?--vapid needs a value}"; shift 2 ;;
		--no-install)  NO_INSTALL=1; shift ;;
		-h|--help)     usage 0 ;;
		*) echo "unknown option: $1" >&2; usage 1 ;;
	esac
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx  \033[0m %s\n' "$*" >&2; exit 1; }

# run privileged commands with sudo only when not already root
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# --- resolve the public IP -------------------------------------------------
if [ -z "$IP" ]; then
	log "Detecting public IP…"
	IP="$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || true)"
	[ -z "$IP" ] && IP="$(curl -fsS --max-time 5 https://ipv4.icanhazip.com 2>/dev/null | tr -d '[:space:]' || true)"
	[ -z "$IP" ] && die "Could not auto-detect the public IP. Pass it with --ip <address>."
fi
echo "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "Not a valid IPv4 address: $IP"
log "Public IP: $IP"

# --- install Docker if missing ---------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	if [ "$NO_INSTALL" -eq 1 ]; then
		die "Docker is not installed and --no-install was given."
	fi
	log "Installing Docker…"
	curl -fsSL https://get.docker.com | $SUDO sh
else
	log "Docker already installed."
fi
docker compose version >/dev/null 2>&1 || die "The Docker Compose v2 plugin is required (got a very old Docker?)."

# --- optional firewall -----------------------------------------------------
if [ "$DO_FIREWALL" -eq 1 ]; then
	if command -v ufw >/dev/null 2>&1; then
		log "Configuring ufw (allowing SSH, 80, 443)…"
		$SUDO ufw allow OpenSSH >/dev/null || $SUDO ufw allow 22/tcp >/dev/null
		$SUDO ufw allow 80/tcp  >/dev/null
		$SUDO ufw allow 443/tcp >/dev/null
		$SUDO ufw allow 443/udp >/dev/null
		if [ "$TURN" -eq 1 ]; then
			log "Opening TURN ports (3478 tcp/udp, 49160-49200/udp)…"
			$SUDO ufw allow 3478/tcp        >/dev/null
			$SUDO ufw allow 3478/udp        >/dev/null
			$SUDO ufw allow 49160:49200/udp >/dev/null
		fi
		$SUDO ufw --force enable
	else
		warn "ufw not found — skipping. Open TCP 22/80/443 (and UDP 443) yourself,"
		warn "e.g. in the Hetzner Cloud Firewall."
		[ "$TURN" -eq 1 ] && warn "For TURN also open 3478/tcp, 3478/udp, and 49160-49200/udp."
	fi
elif [ "$TURN" -eq 1 ]; then
	warn "TURN needs 3478/tcp, 3478/udp, and 49160-49200/udp open (host + cloud"
	warn "firewall). Re-run with --firewall to have ufw do the host side."
fi

# --- generate a VAPID key if none supplied ---------------------------------
if [ -z "$VAPID" ]; then
	log "Generating a VAPID key for durable Web Push…"
	# The 32-byte private scalar sits at DER offset 7 (SEQUENCE, INTEGER
	# version, then a 32-byte OCTET STRING). Count from the FRONT — the raw
	# scalar — not `tail -c 32`, which for a named curve grabs the last 20
	# scalar bytes plus the trailing 12-byte prime256v1 OID (a wrong, weak,
	# curve-OID-contaminated key that push services then can't be signed for).
	if command -v basenc >/dev/null 2>&1; then
		VAPID="$(openssl ecparam -genkey -name prime256v1 2>/dev/null \
			| openssl ec -no_public -outform DER 2>/dev/null \
			| tail -c +8 | head -c 32 | basenc --base64url | tr -d '=')"
	else
		# basenc (coreutils ≥8.31) missing: make base64url from base64 by hand
		VAPID="$(openssl ecparam -genkey -name prime256v1 2>/dev/null \
			| openssl ec -no_public -outform DER 2>/dev/null \
			| tail -c +8 | head -c 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
	fi
	[ -n "$VAPID" ] || warn "VAPID generation failed; push will use an ephemeral key."
fi

# --- optional TURN (coturn) for voice --------------------------------------
# Opt-in: needs extra ports and an extra container, so it's off by default.
# The relay mints short-lived per-user credentials from TURN_SECRET, so the
# secret is shared only between coturn and the relay, never with clients.
TURN_OVERLAY=""
if [ "$TURN" -eq 1 ]; then
	command -v openssl >/dev/null 2>&1 || die "--turn needs openssl to generate TURN_SECRET."
	TURN_SECRET_VAL="${TURN_SECRET_VAL:-$(openssl rand -hex 32)}"
	TURN_OVERLAY="-f deploy/docker-compose.turn.yml"
fi

# --- launch ----------------------------------------------------------------
COMPOSE_BASE="-f docker-compose.yml"

if [ "$SELF_SIGNED" -eq 1 ]; then
	[ -n "$DOMAIN" ] && die "--self-signed and --domain are mutually exclusive."
	log "Mode: raw IP + self-signed cert (browser warning; passkeys disabled)."
	if [ "$TURN" -eq 1 ]; then
		export TURN_SECRET="$TURN_SECRET_VAL"
		export TURN_URLS="turn:$IP:3478?transport=udp,turn:$IP:3478?transport=tcp"
		log "TURN (coturn) enabled — advertising $TURN_URLS"
	fi
	log "Bringing the stack up…"
	SERVER_IP="$IP" VAPID_PRIVATE_KEY="$VAPID" \
		docker compose $COMPOSE_BASE -f deploy/docker-compose.tls-ip.yml $TURN_OVERLAY up --build -d
	URL="https://$IP"
else
	SITE="${DOMAIN:-$IP.sslip.io}"
	log "Mode: real Let's Encrypt cert for '$SITE'."

	# write deploy/.env (back up any existing one)
	if [ -f deploy/.env ]; then
		cp deploy/.env "deploy/.env.bak"
		warn "Existing deploy/.env backed up to deploy/.env.bak"
	fi
	{
		echo "# Generated by deploy/setup.sh"
		echo "CADDY_DOMAIN=$SITE"
		echo "VAPID_PRIVATE_KEY=$VAPID"
		if [ "$TURN" -eq 1 ]; then
			echo "TURN_SECRET=$TURN_SECRET_VAL"
			echo "TURN_URLS=turn:$SITE:3478?transport=udp,turn:$SITE:3478?transport=tcp"
		fi
	} > deploy/.env
	log "Wrote deploy/.env (CADDY_DOMAIN=$SITE)."
	[ "$TURN" -eq 1 ] && log "TURN (coturn) enabled for $SITE."

	log "Bringing the stack up…"
	docker compose --env-file deploy/.env \
		$COMPOSE_BASE -f deploy/docker-compose.tls.yml $TURN_OVERLAY up --build -d
	URL="https://$SITE"
fi

# --- done ------------------------------------------------------------------
cat <<EOF

$(log "Stack is starting.")
Open:  $URL

Watch the certificate get issued:
  docker compose --env-file deploy/.env -f docker-compose.yml -f deploy/docker-compose.tls.yml logs -f caddy

(For --self-signed, drop --env-file and use deploy/docker-compose.tls-ip.yml.)
'certificate obtained successfully' (or an accepted self-signed warning) means TLS is live.
EOF

if [ "$TURN" -eq 1 ]; then
	cat <<EOF

$(log "Voice TURN (coturn) is running.")
Confirm your CLOUD firewall also allows 3478/tcp, 3478/udp, and 49160-49200/udp.
Verify with the Trickle ICE tester and look for 'relay' candidates:
  https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
EOF
fi
