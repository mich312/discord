# Operator runbook

What to do when something breaks. Written for the person who runs a relay
for their club and is willing to read a README but not to debug Rust.

Every command assumes you are in the directory holding `docker-compose.yml`
on the relay host.

## Before an incident: know these three things

```sh
# Is the relay up AND able to reach its database?
curl -s localhost/healthz
# {"ok":true,"users":12}   ← healthy
# {"ok":false,"error":...} ← up, but the database is unreachable
# (no response)            ← the process is down or the port is wrong

# What is it saying?
docker compose logs -f --tail=100 quorum

# Turn up detail (connect/disconnect are info; subscribe is debug)
RUST_LOG=relay=debug docker compose up -d quorum

# Numbers, if you set METRICS_TOKEN in .env
curl -sH "Authorization: Bearer $METRICS_TOKEN" localhost/metrics
```

`/metrics` is **off unless `METRICS_TOKEN` is set** — it returns 404, not 401,
so an unconfigured relay does not advertise it. Everything it serves is
metadata (who is online, how many circles, how fast they are talking), which
is the one thing a relay operator can see and nobody else should. If you point
Prometheus at it, put the token in the scrape config and keep the endpoint off
the public internet.

The three counters worth an alert:

| Metric | Why |
|---|---|
| `quorum_ws_auth_failures_total{reason="unregistered"}` | climbing on its own is someone enumerating handles |
| `quorum_push_total{outcome="failed"}` | all-failing is a lost VAPID key — see *Push notifications stopped* |
| `quorum_history_swept_total` | flat at zero forever means the retention sweep is not running |

State that must survive lives in exactly three places, and one of them is
not where you would look:

| What | Where | Losing it means |
|---|---|---|
| Messages, rosters, invites, vaults | the `pgdata` volume | everything is gone |
| Attachments **and the VAPID key** | the `blobs` volume, mounted at `/data` | attachments 404; **all push subscriptions silently die** |
| TLS certificates | the `caddy_data` volume | re-issued automatically, but rate limits apply |

---

## "Messages aren't arriving"

The most common report, and until recently there was nothing to look at.
Work down this list; each step rules out a layer.

**1. Is the relay healthy?**

```sh
curl -s localhost/healthz
```

Not `{"ok":true}` → skip to *Relay is down* or *Database unreachable*.

**2. Is that user actually connected?**

```sh
docker compose logs quorum | grep -E 'client (connected|disconnected)' | tail -20
```

You will see their handle with the current online count. If they never
appear, the problem is between their browser and you — TLS, DNS, a captive
portal, or a client that never got past the boot splash. Ask them to reload
and watch for their handle.

**3. Connected, but is it subscribed?**

```sh
RUST_LOG=relay=debug docker compose up -d quorum
docker compose logs -f quorum | grep subscribed
```

Online-but-not-subscribed is a real state. If a user connects and never
subscribes, their client is failing between authentication and joining the
group's fan-out — usually a corrupt local state. Have them sign out and back
in; their circles come back from the encrypted backup.

**4. Everything looks right and one person still cannot read messages.**

Suspect a **forked group**: two admins committed at the same instant on an
old build. Their client logs `undecryptable blob seq N` for that circle.
Nothing server-side fixes it — the group must be re-created, or the affected
member removed and re-added. New forks are prevented (the relay
compare-and-swaps the epoch), but groups forked before that landed stay
forked.

**Never look for the message content.** There isn't any. The relay holds
ciphertext; if the answer required reading a message, the answer does not
exist.

---

## Relay is down

```sh
docker compose ps            # is the container even running?
docker compose logs --tail=50 quorum
docker compose restart quorum
```

**Crash loop with a Rust panic on startup** is almost always WebAuthn
configuration: `RP_ID` / `RP_ORIGIN` must match the origin users actually
load the client from. `restart: unless-stopped` turns a typo into an endless
loop. Fix the values in `.env` and `docker compose up -d`.

**Restarting is safe.** Clients reconnect with backoff and catch up from the
ordered log; voice is peer-to-peer and survives the relay bouncing entirely.

---

## Database unreachable

`/healthz` returns `{"ok":false}`.

```sh
docker compose ps db
docker compose logs --tail=50 db
df -h                        # a full disk takes Postgres down first
```

If the disk is full, go to the next section — that is the cause, not a
coincidence.

---

## Disk filling up

```sh
df -h
docker system df
du -sh /var/lib/docker/volumes/*
```

Three things grow, and only one of them currently shrinks:

- **History** — swept hourly for expired entries. If this is large, channels
  have long retention or none; that is a per-channel setting only members
  can change.
- **Messages** — the MLS log. **Never pruned.** Every ciphertext ever sent
  is still there. There is no retention job yet; this is a known gap.
- **Attachment blobs** — kept forever *unless* you set `BLOB_TTL_DAYS`.

Immediate relief, in order of preference: raise the volume size; then set
`BLOB_TTL_DAYS` and restart, accepting that attachments past that age will
404 for everyone.

```sh
# In .env, then: docker compose up -d quorum
BLOB_TTL_DAYS=180
```

The sweep runs hourly and only touches files whose names are valid blob ids,
so `vapid.key` — which lives in the same volume — is never at risk. Set the
value **above your longest kept-history retention**: an attachment deleted
while its message is still readable shows up as a permanently broken
download, not as an expired one.

Do **not** hand-delete from `/data` with `find`. The relay's sweep knows which
filenames are blobs; `find /data -type f -delete` does not, and the VAPID key
is in there.

Prevention: alert at 75% rather than discovering this at 100%, because a full
disk takes Postgres with it.

---

## Push notifications stopped for everyone

Almost always a lost or changed VAPID key. The relay generates one on first
boot and persists it to `/data/vapid.key`; if that file is gone, every
existing browser subscription is addressed to a key you no longer hold, and
every send fails silently.

```sh
docker compose exec quorum ls -l /data/vapid.key
docker compose logs quorum | grep -i push | tail -20
```

If it is missing and you have no backup, the only fix is for every member to
disable and re-enable notifications. To make this survivable, set an explicit
`VAPID_PRIVATE_KEY` in `.env` and back it up with the rest of your secrets.

Push for **one** person stopping is different and usually benign: endpoints
rotate, and their client re-subscribes on next load.

---

## Calls do not connect

Media is peer-to-peer, so the relay is rarely the cause.

- Both parties behind symmetric NAT or CGNAT and **no TURN configured** —
  this is the usual answer. Public STUN only traverses cone NATs.
- TURN configured but the container advertises a private address: coturn
  needs `--external-ip` on any provider where the VM does not see its public
  IP (AWS, GCP, Azure, Oracle). Hetzner happens to work without it, which is
  why this bites late.
- More than about eight people in one call. It is a full mesh; each browser
  holds a connection to every other. There is no cap and no warning yet.

---

## Certificate expiry

Caddy renews automatically. If it has not:

```sh
docker compose logs caddy | grep -i -E 'certificate|acme|error' | tail -30
```

Usual causes: port 80 unreachable from outside (ACME needs it even when you
only serve 443), DNS no longer pointing at this host, or a Let's Encrypt rate
limit from repeated failed attempts. Fix the cause and restart Caddy; do not
loop retries, as that deepens the rate limit.

---

## Backups

There is no automated backup. Set one up before you need it.

```sh
# Database
docker compose exec -T db pg_dump -U quorum quorum | gzip > quorum-$(date +%F).sql.gz

# Blobs AND the VAPID key (same volume)
docker run --rm -v quorum_blobs:/data -v "$PWD":/out alpine \
  tar czf /out/blobs-$(date +%F).tar.gz -C /data .
```

**Test the restore.** An untested backup is a belief, not a backup. Restore
into a throwaway stack and check that `/healthz` reports a plausible user
count.

What backups cannot give you: message *content* for a member who lost their
device. The relay never had it. Their circles come back from the encrypted
backup when they sign in; the messages come back only for kept-history
channels.

---

## Upgrading

```sh
docker compose pull
docker compose up -d
curl -s localhost/healthz          # must be {"ok":true,...} before you walk away
docker compose logs --tail=20 quorum | grep -i schema
```

The relay migrates its own database on startup. Migrations run behind an
advisory lock, so starting two instances at once is safe — one waits.

**Back up the database first** (see *Backups*). Not because upgrades usually
go wrong, but because the way out of one that did is a restore.

**Rolling back.** Downgrading the image works only if the schema has not
moved. The relay records the schema version it wrote, and an older build that
finds a *newer* version refuses to start:

```
database is at schema version 2, but this relay understands 1.
It was written by a newer build — upgrade the relay rather than rolling it back.
```

This is deliberate. The alternative — running against a shape the binary does
not understand — corrupts data quietly instead of failing loudly. Your options
are to go back to the newer image, or restore the database from the backup you
took before upgrading. There is no third one, which is the real reason to take
the backup.

Clients need no coordination: they reconnect with backoff and catch up from the
ordered log. Expect a few seconds of reconnect noise in the logs, not silence.

---

## What to escalate rather than fix

- A member reporting they can read a circle they were removed from.
- Any suggestion that the relay served different code to one user.
- `undecryptable blob` appearing for many members at once rather than one.

These touch the encryption guarantee rather than availability. Capture logs,
do not restart to "clear" it, and report via `SECURITY.md`.
