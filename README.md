# quorum — encrypted group chat

Small, persistent, invite-only groups (10–50 people) formed around
something specific — a race team, a photo club, a project. **Discord's
skeleton, Signal's social model.** End-to-end encrypted with
**MLS (RFC 9420)**; the server stores ciphertext it can never read.

This is not a public server you stumble into. E2EE forbids scrollback for
new members, so any positioning that depends on lurking-then-joining is
structurally impossible. The differentiator (encryption) is invisible;
the costs (no history for joiners, no server-side search, no content
moderation) are visible — and the UI says so instead of hiding it.

The full design rationale lives in **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)**;
phases 1–7 of it are implemented. The plan's honest-assessment and
threat-model sections still apply verbatim.

## What works

- **Text channels** inside E2EE servers — channel structure and server
  names travel *inside* the encryption; the relay never learns them.
- **Invite links** (`?j=<id>#k=<key>`) — the decryption key rides in the
  URL fragment, which browsers never transmit. Joining uses MLS External
  Commits, so nobody has to be online to let you in. Link-joiners are
  badged **unverified** until someone checks their safety number.
- **Safety numbers** — symmetric 60-digit fingerprints per member pair,
  derived from the MLS identity keys; verification is device-local
  judgement and flips the badge to ✓.
- **Attachments** — AES-GCM encrypted in the browser under a random
  per-file key that travels inside the MLS message; the relay stores
  opaque bytes on disk under unguessable ids.
- **Voice channels** — audio-only WebRTC mesh (viable to ~6–8; a 1:1
  call is a two-person channel). Signaling is MLS-encrypted and never
  logged, which authenticates the DTLS fingerprints for free. Media is
  peer-to-peer; the server carries none of it. No mic → listen-only.
- **Persistence** — MLS state snapshots in IndexedDB survive reloads
  with live ratchets; the identity key is mirrored to localStorage and
  exportable (file, paste-string, or passphrase-wrapped recovery file).
- **Web Push** — offline members get an encrypted nudge (group id only —
  content never exists server-side). Requires `VAPID_PRIVATE_KEY` in
  production.
- **Accounts (passkeys / password)** — sign in from a new device without
  moving key files. The identity bundle is parked on the relay *encrypted
  client-side*: under a passkey's PRF output (nothing brute-forceable
  anywhere), or the wrap half of Argon2id(password) — the auth half is
  all the server ever checks. Invite-link joiners onboard in seconds and
  are nagged to secure the account afterwards. Signing in restores who
  you are, never old messages — those keys lived on the old device.

## Architecture

| Component | Directory | Stack |
|---|---|---|
| Crypto core | [`crypto-core/`](crypto-core/) | Rust + OpenMLS → WASM, runs in a Web Worker |
| Relay | [`relay/`](relay/) | Rust (axum), WebSocket; ordered log + fan-out over opaque blobs; Postgres or in-memory |
| Web client | [`client/`](client/) | React + Vite; the UI never touches key material |
| Test harness | [`harness/`](harness/) | Bare two-tab Playwright e2e against the relay (no product UI) |

The relay is a **delivery service and ordered log**, nothing more: it
authenticates connections (challenge-response against each user's pinned
MLS identity key — no passwords), stores ciphertext keyed by
`(group_id, epoch, seq)`, hosts pre-published KeyPackages and invite
blobs, enforces per-group ordering, and fans out. It cannot read
messages, membership, channel names, invite blobs, or call signaling.
It *can* observe metadata — who talks to whom, when, how often — and the
docs say so plainly rather than overclaiming.

## Running it

### Docker (recommended)

```sh
docker compose up --build     # quorum + postgres
# open http://localhost:9601
```

Or just the app container (in-memory store, nothing survives restarts):

```sh
docker build -t quorum .
docker run -p 9601:9601 -v quorum-data:/data quorum
```

One container serves everything: the relay, the client, attachments, and
account sign-in on a single port. For any host other than localhost, set
`RP_ID`/`RP_ORIGIN` to your public origin (passkeys are bound to it) and
put TLS in front — WebAuthn and microphone access require a secure
context off localhost.

### From source

```sh
# prerequisites: rust + wasm32 target, wasm-pack, node 20+
crypto-core/build-wasm.sh
(cd client && npm install && npm run build)
CLIENT_DIR=client/dist cargo run -p relay --release
# open http://localhost:9601
```

For client dev with hot reload: `cargo run -p relay` in one shell,
`npm run dev` in another, and open the vite URL with
`?relay=ws://localhost:9601/ws` (the client defaults to a same-origin
relay).

### Relay configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `RELAY_PORT` / `RELAY_BIND` | `9601` / `0.0.0.0` | one port for ws, blobs, accounts, and the client |
| `CLIENT_DIR` | unset | serve the built client from this directory |
| `DATABASE_URL` | unset | Postgres; unset = in-memory (nothing survives restart) |
| `BLOB_DIR` | `./blobs` | encrypted attachment storage on disk |
| `VAPID_PRIVATE_KEY` | unset | base64url P-256 scalar; unset = ephemeral (push subscriptions die on restart) |
| `RP_ID` / `RP_ORIGIN` | `localhost` / `http://localhost:9601` | WebAuthn relying party — must match the origin users load the client from |

For real deployments: terminate TLS in front of the relay (`wss://`),
serve the client over HTTPS with the CSP/SRI hardening from plan §5.1,
and run your own STUN/TURN if members sit behind hard NATs (TURN relays
ciphertext only).

## Testing

```sh
cargo test                                            # 27 tests, in-memory store
TEST_DATABASE_URL=postgres://… cargo test             # + postgres contract tests
cd client && npm run build && npm run e2e             # 18-step browser journey
```

The client e2e drives five real browser profiles through onboarding,
E2EE chat, the no-scrollback guarantee, reload persistence, invite-link
joins, identity recovery, encrypted attachments, safety numbers, and
2-way + 3-way mesh voice calls.

## Status against the plan

| Phase | Work | Status |
|---|---|---|
| 1 | Rust core + OpenMLS → WASM, two tabs exchanging MLS messages | done |
| 2 | Relay: auth, KeyPackage store, ordered delivery, epoch handling | done |
| 3 | Web client: rail, channels, messages, IndexedDB, recovery keys | done |
| 4 | Invite links: encrypted GroupInfo, external commits, unverified UI | done |
| 5 | Attachments + safety numbers | done |
| 6 | Web Push + service worker | done |
| 7 | Voice: 1:1 + audio mesh channels, E2EE signaling | done |
| 8 | Large group calls (LiveKit + SFrame from the MLS exporter secret) | not started — mesh covers this product's group sizes; an SFU only pays off past ~8 concurrent speakers |

## Known limitations (by design or honestly deferred)

- **No scrollback for joiners** — inherent to forward secrecy; shown as a
  permanent watermark, not an error.
- **Metadata is visible to the relay** — who, when, how often, group
  sizes, call participation. E2EE hides content, not traffic shape.
- **Invite-link controls are weak** — expiry/max-uses are server-enforced;
  a malicious relay can bypass them. It still can't read the blob.
  Membership itself is cryptographically enforced and cannot be bypassed.
- **Invite blobs go stale per epoch** — the link creator's client
  refreshes them; if they're offline long enough the link pauses.
- **One device per identity** — cross-device sync is out of scope (each
  device would be its own MLS leaf); recovery restores identity, not
  group ratchets.
- **Password vaults can be brute-forced by the server** — only for weak
  passwords, and only offline against the encrypted bundle (Argon2id,
  19 MiB/t=2). Passkey vaults have no such surface. The sign-in params
  endpoint also confirms whether a username exists.
- **Browser code delivery is the weak point** (plan §5.1) — SRI, strict
  CSP, and reproducible builds mitigate broad silent attacks, not
  targeted ones. State it, don't hide it.
