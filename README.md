# quorum — encrypted group chat

Small, persistent, invite-only groups (10–50 people) formed around
something specific — a race team, a photo club, a project. **Discord's
skeleton, Signal's social model.** End-to-end encrypted with
**MLS (RFC 9420)**; the server stores ciphertext it can never read.

This is not a public server you stumble into. E2EE forbids scrollback for
new members, so any positioning that depends on lurking-then-joining is
structurally impossible. The differentiator (encryption) is invisible;
the costs (no history for joiners by default, no server-side search, no
content moderation) are visible — and the UI says so instead of hiding
it. Channels can *opt in* to kept history via a shared room key — a
deliberate, clearly-labeled forward-secrecy trade, not a loophole.

The full design rationale lives in **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)**;
phases 1–7 of it are implemented. The plan's honest-assessment and
threat-model sections still apply verbatim.

## What works

- **Text channels** inside E2EE servers — channel structure and server
  names travel *inside* the encryption; the relay never learns them.
- **Game hub** — picking a circle lands on its hub: the next event with a
  live countdown, per-room unread counts with the latest line
  (device-local catch-up), a noticeboard any member can pin to (entries
  are authored by the MLS sender; author or admin unpins) — and **the
  shelf**: the games this circle plays, living on their own servers. Web
  games launch embedded in a sandboxed iframe with the room's chat docked
  beside them and the call riding along; native game servers (Minecraft,
  Factorio…) get address cards. The registry travels inside the
  encryption like channel names, so the relay never learns what a circle
  plays — and the UI says plainly what E2EE can't cover: connecting to a
  game shows that game's host your traffic, exactly like opening a pinned
  link. Admins set the event, blurb, pinned links, and the shelf. Joiners
  inherit the page via the encrypted metadata rebroadcast and it rides
  the encrypted backup.
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
- **Voice channels** — audio WebRTC mesh (viable to ~6–8; a 1:1
  call is a two-person channel). Signaling is MLS-encrypted and never
  logged, which authenticates the DTLS fingerprints for free. Media is
  peer-to-peer; the server carries none of it. The mic runs through the
  browser's echo cancellation / noise suppression / auto-gain (all
  toggleable), and every leg is Opus with DTX + a voice bitrate cap so
  silence costs nothing and a mesh stays affordable. Mute, deafen
  (silence everyone + yourself), and — no mic → listen-only.
- **Call stage** — every call opens a dashboard: a bubble per
  participant with live speaking meters, camera video and screen sharing
  (each an extra renegotiated video track, still fully P2P — one person
  can do both at once), soft join/leave chimes, and the call's own
  conversation thread — regular MLS-sealed chat scoped to the room under
  a `voice:<room>` channel id, never a sidebar room.
- **Persistence** — MLS state snapshots in IndexedDB survive reloads
  with live ratchets; the identity key is mirrored to localStorage and
  exportable (file, paste-string, or passphrase-wrapped recovery file).
- **Web Push** — members who didn't get a message live get an encrypted
  nudge (group id + kind only — content never exists server-side). The
  service worker enriches it with what the *device* already knows: the
  circle's name from local IndexedDB, and a distinct sticky notification
  for incoming calls (rings and call starts push-wake the roster via an
  explicit `notify` list on the ephemeral — the relay learns only "wake
  these members", never why). Clicking a notification lands on that
  circle. The relay auto-generates and persists its VAPID key on the data
  volume, so push survives restarts out of the box; set
  `VAPID_PRIVATE_KEY` to pin an explicit key or share one across hosts.
- **Invite-only registration** — the platform itself is gated, not just
  the groups: the relay refuses to pin an unknown handle unless the
  connection presents a currently-usable invite id (the one from the
  `?j=<id>#k=<key>` link). The very first user bootstraps a fresh relay
  without one; set `OPEN_REGISTRATION=1` to turn the gate off for dev.
- **Mobile** — on phone-sized screens the workspace collapses to a single
  pane: circles/rooms and the roster slide in as drawers, touch targets
  grow, and safe areas (notch, home bar) are respected. A web manifest +
  icons make it installable from the browser as a PWA — combined with Web
  Push, that's the mobile app, with no store build to trust separately.
- **Accounts (passkeys / password)** — sign in from a new device without
  moving key files. The identity bundle is parked on the relay *encrypted
  client-side*: under a passkey's PRF output (nothing brute-forceable
  anywhere), or the wrap half of Argon2id(password) — the auth half is
  all the server ever checks. Invite-link joiners onboard in seconds and
  are nagged to secure the account afterwards. Signing in restores who
  you are and (via the circles backup) what you knew — live group keys
  still lived on the old device, so sending needs a re-add.
- **Channel settings** (admins, per channel) — a topic shown at the top
  of the room, auto-delete, and kept history. Settings travel inside the
  encryption like channel names; changes are announced in the channel.
- **Kept history (opt-in, per channel)** — off by default: messages exist
  only on devices that were present. Switched on, each message is *also*
  sealed under a per-channel **room key** (AES-GCM) and parked on the
  relay beneath an opaque log id. The room key travels only inside MLS
  metadata, so being in the roster — joining — is exactly how you get it;
  new members and your own next device read the channel's past. Honest
  costs, shown in the UI: forward secrecy for that channel's content is
  deliberately given up (anyone admitted later can read what the key
  unlocks), and restored entries are authenticated by the room key, not
  per-sender signatures.
- **Auto-delete** — per-channel retention (1 hour to 30 days). Entries in
  the relay's history log carry an expiry the server enforces; devices
  prune their local copies when they open the room. A shared setting
  honored by clients, not a cryptographic guarantee — and it usefully
  bounds what a kept-history room key can ever unlock.
- **Circles backup / new-device restore** — the *shape* of your circles
  (names, channels, settings, room keys) is parked on the relay encrypted
  under a key derived from your identity bundle — the same bytes the
  account vault already round-trips, so any device that can sign in can
  open it and the relay never can. Sign in somewhere new: your circles
  reappear read-only, kept-history channels are readable immediately, and
  a re-add (or invite link) makes them live again.

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
`(group_id, epoch, seq)`, hosts pre-published KeyPackages, invite
blobs, per-channel history logs (opaque ids, AES-GCM ciphertext), and
identity-encrypted circles backups, enforces per-group ordering, and
fans out. It cannot read messages, membership, channel names, invite
blobs, history entries, backups, or call signaling.
It *can* observe metadata — who talks to whom, when, how often — and the
docs say so plainly rather than overclaiming.

## Running it

### Docker (recommended)

```sh
docker compose up --build     # quorum + postgres
# open http://localhost
```

Or just the app container (in-memory store, nothing survives restarts):

```sh
docker build -t quorum .
docker run -p 80:80 -v quorum-data:/data quorum
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
| `RELAY_PORT` / `RELAY_BIND` | `9601` / `0.0.0.0` | one port for ws, blobs, accounts, and the client (the Docker image sets `80`) |
| `CLIENT_DIR` | unset | serve the built client from this directory |
| `DATABASE_URL` | unset | Postgres; unset = in-memory (nothing survives restart) |
| `BLOB_DIR` | `./blobs` | encrypted attachment storage on disk |
| `VAPID_PRIVATE_KEY` | unset | base64url P-256 scalar; unset = ephemeral (push subscriptions die on restart) |
| `OPEN_REGISTRATION` | unset | unset/`0` = invite-only: unknown handles register only with a usable invite id (the first user on an empty relay is exempt); `1`/`true` = anyone can register |
| `TRUST_PROXY` | unset | `1` = key the rate limits on the first `X-Forwarded-For` hop instead of the socket peer — set it ONLY behind a proxy that overwrites the header (the `deploy/` Caddy setups do) |
| `TURN_URLS` / `TURN_SECRET` | unset | voice TURN via coturn's REST API — the relay mints a short-lived credential per user (no shared password to clients). `TURN_TTL` (default 3600) sets its lifetime |
| `ICE_SERVERS` | public STUN | verbatim JSON array of RTCIceServer objects; an alternative to `TURN_*` (static creds). Unset = public STUN, which only traverses cone NATs |
| `RP_ID` / `RP_ORIGIN` | `localhost` / `http://localhost:9601` | WebAuthn relying party — must match the origin users load the client from |
| `RELAY_ADMINS` | unset | comma-separated handles treated as global admins: they can manage any group's ACL/roles and list all users/groups — metadata only, they cannot read messages |

Membership roles: whoever creates a group is its admin; admins add
members, manage invites, and promote/demote via the roster. This gates
the relay's (deliberately weak) ACL — the cryptographic boundary stays
MLS membership.

For real deployments: terminate TLS in front of the relay (`wss://`) and
run your own STUN/TURN if members sit behind hard NATs (TURN relays
ciphertext only). The relay itself serves the plan-§5.1 hardening on
every response — a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`,
no inline or eval'd JS), nosniff, frame denial, and a minimal
Permissions-Policy — and the client build stamps SRI hashes onto its
entry assets. The Caddy setup adds HSTS on top. **[`deploy/`](deploy/)** has a ready-to-run Caddy setup
that auto-provisions Let's Encrypt certificates — see
[`deploy/README.md`](deploy/README.md) for a step-by-step Hetzner VM walkthrough.

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
  endpoint also confirms whether a username exists; online guessing and
  enumeration sweeps are rate-limited per client IP (10 credential
  attempts/min, 30 probes/min, 60 new connections/min — per relay
  process, in memory).
- **Browser code delivery is the weak point** (plan §5.1) — the strict
  CSP and SRI now ship by default and mitigate broad silent attacks, not
  targeted ones; SRI can't cover the worker/wasm (no tag to carry it),
  and reproducible builds with published hashes remain open. State it,
  don't hide it.
