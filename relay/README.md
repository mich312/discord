# relay

Rust (axum) WebSocket server. A **delivery service and ordered log** —
nothing more. It parses JSON envelopes; every MLS payload stays an opaque
base64 blob it cannot read.

## What it does

- **Auth**: challenge-response against the user's Ed25519 MLS identity key.
  Trust-on-first-use — the first successfully-signed connection pins the
  key; later connections must sign with it. No passwords.
- **KeyPackage store**: clients pre-publish KeyPackages; each fetch
  consumes one, enabling member addition while the joiner is offline.
- **Ordered log**: opaque blobs in Postgres keyed by `(group_id, seq)`
  with the client-declared epoch alongside; seq is server-assigned and
  append + fan-out are serialized, so every subscriber observes the log
  in seq order. `subscribe {after}` replays missed messages on reconnect.
- **Welcome delivery**: addressed to one user, stored if they're offline,
  flushed on their next connection. Carries `group` and `after` so the
  joiner knows where the MLS log resumes for them.
- **Channel logs**: the conversation itself. One append-only log per
  channel under a client-chosen opaque id (`hid`) the relay cannot map to
  a channel name, holding AES-GCM ciphertext under a room key the relay
  never sees. Reads are paged in either direction and clamped server-side.
  Each entry records its author — the authenticated handle that appended
  it — which is what authorizes a redaction and what lets a client ask
  "how many entries have I missed" without decrypting anything. Retention
  is enforced here: expired entries are deleted, on read and on a sweep.
- **ACL**: `create_group` / `allow` / membership checks gate subscribe and
  send. This is server-enforced (therefore weak) spam control — the
  cryptographic boundary is MLS membership, which the server can't affect.

## What it cannot do — by design

Read messages, group state, invite blobs, or channel-log entries. It *can*
observe metadata (who talks to whom, when, how often, how much each
channel holds, and which member appended each entry) and it *can* lie
about delivery — which is why clients verify membership cryptographically,
check each log entry's signature against keys taken from the MLS roster
rather than from anything the relay says, and never trust the server's
word for either.

## Protocol

JSON over WebSocket text frames at `/ws`. `rid` correlates requests with
acks. Auth: `hello {user, pubkey}` → `challenge {nonce}` →
`auth {sig}` (over `"relay-auth-v2" || nonce || u32be(len(user)) || user`
— the handle is bound in, so a captured signature proves who it
authenticates rather than merely that the key holder was live) → `ready`.

| Request | Reply | Notes |
|---|---|---|
| `publish_kp {payloads[]}` | `ok` | pre-publish KeyPackages |
| `fetch_kp {user}` | `kp {payload?}` | consumes one; null when exhausted |
| `create_group {group}` | `ok` | creator becomes member + subscriber |
| `allow {group, user}` | `ok` | members only |
| `subscribe {group, after}` | `ok` + backlog `msg`s | members only |
| `send {group, epoch, payload}` | `ok {seq}` | members only; fans out `msg` |
| `welcome {to, group, after, payload}` | `ok` | direct or stored offline |
| `create_invite {invite, group, payload, expires_at?, max_uses?}` | `ok` | members only; parks an encrypted GroupInfo blob |
| `update_invite {invite, payload}` | `ok` | members only; fresh epoch's blob, same invite id |
| `revoke_invite {invite}` | `ok` | members only |
| `redeem_invite {invite}` | `invite {group, payload}` | enforces expiry/max-uses, grants ACL membership |
| `ephemeral {group, payload}` | `ok` + fan-out `eph` | members only; NOT logged — voice presence/WebRTC signaling |
| `history_append {group, hid, ts, expires_at?, payload}` | `ok {seq}` | members only; records the caller as the entry's author |
| `history_fetch {group, hid, after, before?, limit?}` | `history {hid, entries[], complete}` | members only; `before` pages backwards, `limit` is clamped |
| `history_redact {group, hid, seq}` | `ok` | members only; removes the entry if the caller wrote it, or is an admin. Answers identically either way |
| `history_counts {group, logs[{hid, after_ts}]}` | `history_count {counts[]}` | members only; per-log count of entries past `after_ts` that the caller did not write |
| `history_prune {group, hid, before_ts}` | `ok` | admins only; retention |

Invite expiry and use-counting are **server-enforced and therefore weak**
(a malicious relay can hand the blob to anyone). What it cannot do is read
the blob — the decryption key travels in the invite URL's fragment and
never reaches the server. Cryptographic membership remains the only strong
boundary.

Server events: `msg {group, seq, epoch, sender, payload}`,
`welcome {from, group, after, payload}`,
`eph {group, sender, payload}` (transient, never replayed).

## Attachments

`PUT /blobs/{id}` / `GET /blobs/{id}` — opaque AES-GCM ciphertext stored
as plain files on the relay's disk (`BLOB_DIR`, default `./blobs`).
Ids are client-generated random capabilities (strict token alphabet, no
listing, no overwrite); the file key travels inside the MLS message and
never reaches this process. 25 MB cap.

## Web Push

`push_info` returns the VAPID public key; `push_subscribe` stores a
browser PushSubscription. When traffic lands for a member with no live
connection (a group message, or a Welcome stored offline), the relay
sends an aes128gcm-encrypted push carrying only what it already knows —
the group id, never content. Dead endpoints are dropped on 404/410.
The VAPID key must not change across restarts: browsers bind a
subscription to the advertised key, and the push service rejects
everything — new registrations included — once it rotates. Resolution
order: `VAPID_PRIVATE_KEY` (base64url raw P-256 scalar) if set; else an
auto-generated key persisted at `VAPID_KEY_FILE` (the container image
points this at the data volume, so it survives restarts with no operator
action); else — neither available, e.g. a bare dev run — a per-process
ephemeral key, and subscriptions die on restart. A malformed
`VAPID_PRIVATE_KEY` logs an error and falls back to the persisted/ephemeral
key rather than aborting startup — push degrades, but the relay stays up.

## Accounts

The vault is the user's identity bundle encrypted **client-side** — under
a passkey's PRF output or the wrap half of Argon2id(password). The relay
gates retrieval (password: SHA-256 verifier of the auth half; passkey: a
verified WebAuthn assertion) but can never decrypt what it returns.
Set over the authenticated ws (`vault_set`, `vault_status`,
`passkey_register_start/finish`); retrieved pre-auth over HTTP
(`GET /account/{user}/params`, `POST /account/{user}/login`,
`POST /account/{user}/passkey/challenge|login`). `RP_ID`/`RP_ORIGIN`
configure the WebAuthn relying party and must match the client's origin.

## Static serving

Set `CLIENT_DIR` to serve the built client from the same process and
port — the single-container deployment mode.

## Storage

`Store` trait with two impls: `MemoryStore` (tests, zero-config runs) and
`PgStore` (sqlx). Selected at startup: `DATABASE_URL` set → Postgres,
unset → in-memory with a warning.

## Run & test

```sh
cargo run -p relay                       # in-memory, RELAY_PORT=9601
DATABASE_URL=postgres://… cargo run -p relay

cargo test -p relay                      # in-memory + ws integration tests
TEST_DATABASE_URL=postgres://… cargo test -p relay   # + postgres contract tests
```

The integration tests (`tests/relay_flow.rs`) run real MLS clients
(crypto-core natively) over real WebSockets: auth pinning, KeyPackage
consume-once, offline-Welcome join, ordered catch-up, ACLs.
