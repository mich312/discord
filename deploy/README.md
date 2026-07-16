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
