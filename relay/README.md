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
  joiner knows where their log begins — history before that point never
  existed for them.
- **ACL**: `create_group` / `allow` / membership checks gate subscribe and
  send. This is server-enforced (therefore weak) spam control — the
  cryptographic boundary is MLS membership, which the server can't affect.

## What it cannot do — by design

Read messages, group state, or invite blobs. It *can* observe metadata
(who talks to whom, when, how often) and it *can* lie about delivery —
which is why clients verify membership cryptographically and never trust
the server's word for it.

## Protocol

JSON over WebSocket text frames at `/ws`. `rid` correlates requests with
acks. Auth: `hello {user, pubkey}` → `challenge {nonce}` →
`auth {sig}` (over `"relay-auth-v1" || nonce`) → `ready`.

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

Invite expiry and use-counting are **server-enforced and therefore weak**
(a malicious relay can hand the blob to anyone). What it cannot do is read
the blob — the decryption key travels in the invite URL's fragment and
never reaches the server. Cryptographic membership remains the only strong
boundary.

Server events: `msg {group, seq, epoch, sender, payload}`,
`welcome {from, group, after, payload}`.

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
