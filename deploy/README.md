# Deploying quorum with HTTPS on a Hetzner VM

The relay serves plain HTTP on one port and does no TLS itself — the design
puts a reverse proxy in front to terminate TLS. This directory contains a
ready-to-run [Caddy](https://caddyserver.com) setup that provisions and renews
a Let's Encrypt certificate automatically.

You need HTTPS for more than politeness: **off `localhost`, WebAuthn (passkeys)
and microphone access require a secure context**, so passkey sign-in and voice
calls simply won't work over plain HTTP.

```
Internet ──443──▶ Caddy (TLS termination, auto Let's Encrypt) ──▶ quorum:80 ──▶ postgres
```

The rest of this guide assumes you have a **domain**. If you only have an IP
address, read the next section first — then the DNS/firewall/launch steps still
apply.

## No domain? Using just an IP address

Two constraints make a bare IP awkward:

1. **Public CAs don't issue ordinary certificates for IP addresses** — they
   certify domain names.
2. **Passkeys (WebAuthn) can't use an IP at all.** The spec requires the
   relying-party ID to be a domain, so browsers reject an IP. Password accounts
   and all E2EE chat/voice still work; passkey sign-in does not.

You have two options. **The fastest way through either is the script below**
(`deploy/setup.sh`) — it auto-detects your IP and does everything. The manual
steps follow if you'd rather run them yourself.

### Fastest: the setup script

From a clone of this repo on the VM:

```sh
sudo ./deploy/setup.sh --firewall
```

That auto-detects the public IP, installs Docker if missing, opens 22/80/443
(with `--firewall`), generates a VAPID key, writes `deploy/.env`, and brings the
stack up on `https://<ip>.sslip.io` with a real Let's Encrypt cert. Variations:

```sh
sudo ./deploy/setup.sh --domain chat.example.org   # your own hostname
sudo ./deploy/setup.sh --self-signed               # raw IP, self-signed cert
sudo ./deploy/setup.sh --help                       # all options
```

It's safe to re-run (it backs up any existing `deploy/.env`). The manual
equivalents are below.

### Option A (recommended): a free hostname that resolves to your IP

Wildcard-DNS services like **[sslip.io](https://sslip.io)** and
**[nip.io](https://nip.io)** map `<ip>.sslip.io` → `<ip>` with no signup. Because
that's a real hostname, Caddy gets a genuine Let's Encrypt certificate — **no
browser warning, and passkeys work.** Nothing extra to install; just use the
standard setup (§3–§4) with the magic hostname as your domain:

```sh
cp deploy/.env.example deploy/.env
# in deploy/.env:  CADDY_DOMAIN=203.0.113.10.sslip.io
docker compose --env-file deploy/.env \
  -f docker-compose.yml -f deploy/docker-compose.tls.yml up --build -d
```

Open `https://203.0.113.10.sslip.io`. Skip §1 (DNS) — sslip.io resolves for you.

### Option B: the raw IP with a self-signed certificate

If you must have the IP in the URL, Caddy can mint a self-signed cert
(`tls internal`). The app works **after clicking through a certificate warning**
on each device, and **passkeys stay off** (IP relying-party ID). Do the firewall
step (§2) and install Docker (§3), then:

```sh
git clone https://github.com/mich312/discord.git quorum && cd quorum

SERVER_IP=203.0.113.10 docker compose \
  -f docker-compose.yml -f deploy/docker-compose.tls-ip.yml up --build -d
```

Open `https://203.0.113.10`, accept the warning once. (Set `VAPID_PRIVATE_KEY`
in the same `SERVER_IP=... VAPID_PRIVATE_KEY=... docker compose ...` line to keep
push subscriptions across restarts.) No ACME happens, so §1 (DNS) doesn't apply
and port 80 isn't strictly required — but leave it open for the HTTP→HTTPS
redirect.

## 1. DNS

Point a domain at the VM **before** starting the stack — Caddy proves control
of the domain over HTTP on port 80, which only works once DNS resolves to this
machine.

In Hetzner Cloud, note the server's public IPv4 (and IPv6) from the console,
then at your DNS provider create:

| Type | Name               | Value            |
|------|--------------------|------------------|
| A    | `chat.example.org` | `<VM IPv4>`      |
| AAAA | `chat.example.org` | `<VM IPv6>`      |

Verify it has propagated: `dig +short chat.example.org` returns the VM's IP.

## 2. Firewall

Open **80** and **443** (TCP; also 443/UDP if you want HTTP/3). Port 80 is
required — Caddy uses it for the ACME HTTP-01 challenge and to redirect to
HTTPS.

If you use a **Hetzner Cloud Firewall**, add inbound rules for TCP 22, 80, 443
(and UDP 443). If you also run a host firewall (`ufw`):

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

## 3. Install Docker

On a fresh Hetzner Ubuntu/Debian image:

```sh
curl -fsSL https://get.docker.com | sh
```

## 4. Configure and launch

```sh
git clone https://github.com/mich312/discord.git quorum && cd quorum

cp deploy/.env.example deploy/.env
nano deploy/.env          # set CADDY_DOMAIN (and VAPID_PRIVATE_KEY)

docker compose --env-file deploy/.env \
  -f docker-compose.yml -f deploy/docker-compose.tls.yml up --build -d
```

Caddy fetches a certificate on first boot; the site is live at
`https://chat.example.org` within a few seconds. Watch it happen:

```sh
docker compose --env-file deploy/.env \
  -f docker-compose.yml -f deploy/docker-compose.tls.yml logs -f caddy
```

`certificate obtained successfully` means TLS is up. Certificates auto-renew —
nothing else to do.

## What the TLS overlay changes

`deploy/docker-compose.tls.yml` layers on top of the base `docker-compose.yml`:

- **Removes** the relay's `80:80` host port — it's now reachable only from
  Caddy over Docker's internal network, never directly from the internet.
- **Sets** `RP_ID`/`RP_ORIGIN` to `https://$CADDY_DOMAIN` so passkeys bind to
  the real origin.
- **Adds** the `caddy` service, which owns 80/443 and proxies everything —
  HTTP, the `/ws` WebSocket, `/blobs`, and account endpoints — to `quorum:80`.

Certificates and the ACME account live in the `caddy_data` volume, so they
survive restarts and you don't re-hit Let's Encrypt rate limits.

## Troubleshooting

- **Cert not issued / ACME failing** — DNS isn't pointing at this VM yet, or
  port 80 is blocked. Confirm `dig +short chat.example.org` shows the VM IP and
  that both firewalls (Hetzner Cloud + host) allow 80. While iterating, flip on
  the Let's Encrypt staging CA in `deploy/Caddyfile` to avoid the production
  rate limit, then remove it once it works.
- **Passkeys / mic still failing** — `RP_ORIGIN` must exactly match the URL in
  the browser bar (scheme + host, no trailing slash). It's derived from
  `CADDY_DOMAIN`; a mismatch (e.g. `www.` vs bare) breaks WebAuthn.
- **Want to test the cert renewal chain** — `docker exec` into the Caddy
  container; `caddy validate` and the logs show expiry and renewal timing.

## Alternative: nginx / your own proxy

If you already run nginx or Traefik, skip Caddy and point your proxy at the
relay. The only requirements are TLS termination and WebSocket upgrade
forwarding on `/ws`. Minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:9601;   # or wherever the relay binds
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # WebSocket upgrade for /ws
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Get the certificate with `certbot --nginx`, and still set
`RP_ID`/`RP_ORIGIN` on the relay to your `https://` origin.
