# quorum — encrypted group chat

Small, persistent, invite-only groups (10–50 people) formed around
something specific — a race team, a photo club, a project. **Discord's
skeleton, Signal's social model.** End-to-end encrypted; the server
stores ciphertext it can never read.

**The conversation lives on the relay, encrypted under a key the whole
circle holds.** Each channel has a room key that travels only inside the
group's MLS messages, so joining is how you get it — and reading a room
means reading it back from the relay, not from whatever this device
happened to be awake for. Devices hold keys; they do not hold messages.
That makes a new phone, a fresh sign-in and a new member all see the same
room, and it is what the rest of the design now follows from.

The cost is stated rather than buried: **forward secrecy for message
content is given up**. Anyone admitted to a circle can read what its room
keys unlock, and one leaked key opens everything that key ever covered.
Per-channel auto-delete is the bound on that, and it is server-enforced.
Membership is still cryptographic — MLS (RFC 9420) distributes and
rotates the room keys, and the relay cannot join a circle or read a
message. What it can now do is hold the whole conversation in ciphertext,
which is the trade this design makes deliberately.

The differentiator (encryption) is invisible; the remaining costs
(no server-side search, no content moderation, no forward secrecy) are
visible — and the UI says so instead of hiding it.

The full design rationale lives in **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)**;
phases 1–7 of it are implemented. Its §2 table — the one that says
scrollback for joiners is impossible and each device keeps its own store
— describes the design this replaced, and is annotated there rather than
quietly rewritten. The honest-assessment section still applies verbatim.

Also worth reading before you run one for other people:
**[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)** (what the encryption does and
does not protect), **[docs/CAPACITY.md](docs/CAPACITY.md)** (the limits, and
which of them have never been measured), and
**[deploy/RUNBOOK.md](deploy/RUNBOOK.md)** (what to do when it breaks).

And if you are *using* someone else's relay rather than running one:
**[docs/VERIFYING.md](docs/VERIFYING.md)** shows how to rebuild the source and
check it matches the code you were actually served. Web-delivered encryption
means the operator ships the software that holds your keys; that check is the
only thing that makes the claim falsifiable.

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
  silence costs nothing and a mesh stays affordable. Mute, and — no mic
  → listen-only.
- **Call stage** — every call opens a dashboard: a bubble per
  participant with live speaking meters, camera video and screen sharing
  (each an extra renegotiated video track, still fully P2P — one person
  can do both at once), soft join/leave chimes, and the call's own
  conversation thread — regular MLS-sealed chat scoped to the room under
  a `voice:<room>` channel id, never a sidebar room.
- **Persistence** — the device stores keys, not messages: MLS state
  snapshots in IndexedDB survive reloads with live ratchets, and the
  identity key is mirrored to localStorage and exportable (file,
  paste-string, or passphrase-wrapped recovery file). Rooms are read back
  from the relay a page at a time, so what a device shows is what the
  circle has rather than what that device was present for.
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
  of the room and auto-delete. Settings travel inside the encryption like
  channel names; changes are announced in the channel. There is no switch
  for whether a channel keeps history: every channel does.
- **The channel log** — each message is sealed under its channel's
  **room key** (AES-GCM) and appended to a log on the relay beneath an
  opaque id it cannot map to a channel. Edits, deletions and reactions are
  entries in the same log, so they survive a reload and reach a device
  that was offline for them; readers fold them over the original in relay
  order. Deleting also asks the relay to drop the original entry, which it
  authorizes against the author it recorded at append time — so a later
  joiner cannot read it with the room key. Nothing can reach a device that
  already read the line, and the UI says so at the button.
- **Signed entries** — the room key proves an entry came from someone in
  the roster; it cannot say which member, since everyone holds it. So each
  entry carries an Ed25519 signature by its author's MLS identity key —
  the same key safety numbers are computed from — bound to the entry's
  circle and channel so it cannot be replayed elsewhere. Readers check it
  against a key directory built from the MLS roster (never from anything
  the relay says) and drop entries that fail. A line that cannot be
  attributed still renders, marked, and never shares a header with one
  that can.
- **Auto-delete** — per-channel retention (1 hour to 30 days). Entries in
  the relay's history log carry an expiry the server enforces; devices
  prune their local copies when they open the room. A shared setting
  honored by clients, not a cryptographic guarantee — and it usefully
  bounds what a kept-history room key can ever unlock.
- **Circles backup / new-device restore** — the *keys* to your circles
  (names, channels, settings, room keys, and the directory of which
  identity key speaks for which member) are parked on the relay encrypted
  under a key derived from your identity bundle — the same bytes the
  account vault already round-trips, so any device that can sign in can
  open it and the relay never can. Sign in somewhere new: your circles
  reappear read-only with their conversations intact, and a re-add (or
  invite link) makes them live again.

## Architecture

| Component | Directory | Stack |
|---|---|---|
| Crypto core | [`crypto-core/`](crypto-core/) | Rust + OpenMLS → WASM, runs in a Web Worker |
| Relay | [`relay/`](relay/) | Rust (axum), WebSocket; ordered log + fan-out over opaque blobs, plus the per-channel message logs; Postgres or in-memory |
| Web client | [`client/`](client/) | React + Vite; the UI never touches key material |
| Test harness | [`harness/`](harness/) | Bare two-tab Playwright e2e against the relay (no product UI) |

The relay is a **delivery service and an archive it cannot read**: it
authenticates connections (challenge-response against each user's pinned
MLS identity key — no passwords), stores ciphertext keyed by
`(group_id, epoch, seq)`, hosts pre-published KeyPackages, invite blobs,
identity-encrypted circles backups, and the per-channel message logs
(opaque ids, AES-GCM ciphertext, paged on read), enforces per-group
ordering and retention, and fans out. It cannot read messages,
membership, channel names, invite blobs, log entries, backups, or call
signaling.

It *can* observe metadata — who talks to whom, when, how often — and,
since the conversation now lives there, rather more of it: how many
entries each channel holds, when each landed, and which member appended
it. That last one is recorded deliberately, because authorizing a
deletion and counting what you missed both need an answer the ciphertext
cannot give. The docs say so plainly rather than overclaiming.

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
| `TRUST_PROXY` | unset | `1` = key the rate limits on the last `X-Forwarded-For` hop (the one your own proxy appended) instead of the socket peer — set it ONLY behind a proxy, since without one the header is client-controlled |
| `TURN_URLS` / `TURN_SECRET` | unset | voice TURN via coturn's REST API — the relay mints a short-lived credential per user (no shared password to clients). `TURN_TTL` (default 3600) sets its lifetime |
| `ICE_SERVERS` | public STUN | verbatim JSON array of RTCIceServer objects; an alternative to `TURN_*` (static creds). Unset = public STUN, which only traverses cone NATs |
| `STUN_URLS` | unset | comma-separated STUN URLs, merged into the served ICE list. An alternative to the public-STUN default when you run your own |
| `RUST_LOG` | unset | standard `tracing` filter, e.g. `relay=debug`. The relay logs connect/disconnect at info and subscribe at debug |
| `RP_ID` / `RP_ORIGIN` | `localhost` / `http://localhost:9601` | WebAuthn relying party — must match the origin users load the client from |
| `RELAY_ADMINS` | unset | comma-separated handles treated as global admins: they can manage any group's ACL/roles and list all users/groups — metadata only, they cannot read messages |
| `BLOB_TTL_DAYS` | unset | unset/`0` = attachments are kept forever (the default). Set to a whole number of days to delete attachment blobs older than that. Age-based by necessity: the blob id lives inside the encrypted message referring to it, so the relay cannot know which blobs are still wanted. **Set it above your longest kept-history retention**, or an attachment can 404 while its message is still readable |
| `METRICS_TOKEN` | unset | unset = `/metrics` returns 404 and no metrics are served at all. Set it to enable a Prometheus scrape at `/metrics`, authenticated with `Authorization: Bearer <token>`. Treat it as a secret: the metrics are pure metadata — online counts, circle counts, message rates — which is exactly what the relay is otherwise the only party to see |

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
cargo test                                            # relay + crypto core, in-memory store
TEST_DATABASE_URL=postgres://… cargo test             # + postgres contract tests
cd client && npm test                                 # client unit tests
cd client && npm run build && npm run e2e             # 18-step browser journey
```

The client e2e drives five real browser profiles through onboarding,
E2EE chat, joiners reading a room's past, reload persistence, invite-link
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

- **No forward secrecy for message content** — the deliberate centre of
  this design, not an oversight. A circle's messages sit on the relay
  under room keys the roster holds, so anyone admitted later can read the
  past, and one leaked key opens everything it ever covered. Removal
  rotates the key forward (old keys are kept for reading, never dropped —
  they are the only thing that opens those messages), auto-delete bounds
  the window, and the room header says so where the messages are.
- **Deleting is best-effort against readers who were there** — the relay
  drops the entry and every reader folds a tombstone over it, but a device
  that already read the line keeps it. Stated at the button.
- **The relay records who appended each log entry** — it sees this at
  write time regardless (the append arrives on that member's own
  connection), but it is now kept, so a database dump maps entries to
  speakers. It buys two things the ciphertext cannot answer: authorizing a
  deletion, and counting what you have missed without your device
  downloading every channel.
- **Metadata is visible to the relay** — who, when, how often, group
  sizes, call participation. E2EE hides content, not traffic shape.
- **Invite-link controls are weak** — expiry/max-uses are server-enforced;
  a malicious relay can bypass them. It still can't read the blob.
  Membership itself is cryptographically enforced and cannot be bypassed.
- **Invite blobs go stale per epoch** — the link creator's client
  refreshes them; if they're offline long enough the link pauses.
- **Devices share one identity, not one ratchet** — several devices can
  hold the same identity (link one from a signed-in device, or enrol a
  passkey per device; Settings lists them and revokes any one). What they
  do *not* share is MLS state: each device is not its own leaf, so a
  second device joins the group afresh and sees no scrollback, and
  identity recovery restores the identity, never the group ratchets.
  Revocation is forward-only — it stops that passkey unlocking the
  identity again, and cannot erase what a device already holds.
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
