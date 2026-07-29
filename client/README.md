# client

The web client (React + Vite). Talks to `crypto-core` running in a Web
Worker; **never touches key material** — the main thread sees ciphertext
blobs, decrypted events, and opaque state snapshots only.

## Architecture

- `public/worker.js` — the crypto boundary. Owns the WASM `Client`;
  mutating commands piggyback a full MLS state snapshot which the main
  thread persists to IndexedDB, so a reload resumes with live ratchets.
- `src/lib/controller.js` — orchestration: worker ↔ relay ↔ IndexedDB ↔
  React. Owns the canonical server records.
- `src/lib/relay.js` — relay socket: challenge-response auth (signed by
  the MLS identity key in the worker), rid-correlated requests, reconnect
  with backoff; on ready it re-subscribes each group from `lastSeq` and
  tops up the KeyPackage store.
- `src/lib/db.js` — IndexedDB: MLS state snapshot and circle records
  (names, channels, settings, room keys, key directory). **Keys, not
  messages** — the conversation lives in the relay's per-channel logs and
  is read back from there each session.
- `src/lib/log.js` — the fold: what a page of decrypted, signature-checked
  log entries means. Content, edits, deletions and reactions are separate
  append-only entries; the fold replays them in relay order, so a page that
  arrives out of order still converges.
- `src/lib/history.js` — log-entry crypto: seal/open under the room key,
  and the exact bytes an entry's author signs (bound to its circle and log
  id, so an entry cannot be replayed into another channel).
- `src/lib/keys.js` — the key directory: which identity key speaks for
  which handle, built from the MLS roster rather than from anything the
  relay says, and carried in the encrypted backup.
- `src/lib/recovery.js` — recovery key: identity bundle wrapped with
  PBKDF2-SHA256 (310k) → AES-256-GCM under a generated code.

### Servers and channels

One MLS group per server. Channels are routing *inside* the encryption —
message plaintext is a JSON envelope (`{k:'chat', ch, text}`,
`{k:'chan', ch}`, `{k:'meta', name, channels}`), so the relay never learns
channel structure or server names. Server metadata is rebroadcast
(encrypted) after every member add; it carries the room keys, which is how
a joiner comes to be able to read the channel logs at all.

### Load-bearing UI (per the plan)

- The roster is the security boundary — "everyone who holds the keys",
  with add-member right there, and the key epoch visible in the masthead.
- The top of a channel is either "read further back" or the start of the
  record — the circle's, not this device's.
- Composer states the encryption scope ("sealed for N members").
- Onboarding cannot be completed without downloading the recovery file
  and confirming the code is stored off-device.

### Design system — "afterdark"

**The rules live in [docs/DESIGN_GUIDELINES.md](../docs/DESIGN_GUIDELINES.md),
and several of them are enforced by tests. What follows is orientation, not
the contract** — this section previously described a system ("the register":
signal-yellow, 0–2px radii, no pills, no gradients, `identicon.js` cipher
marks) that had been replaced wholesale, down to a file that no longer
exists. Prose drifts; keep the rules where a test can reach them.

The UI is its own product language, not a Discord/Slack skin. A private
arcade rather than a terminal: true-black neutral surfaces, soft geometry
(10px radii, round avatars, pills for counts), and colour carried by
identity — member orbs and game covers hold the saturation while the chrome
around them stays dark and out of the way. Two themes off one token contract
in `src/styles.css` — **carbon** (dark, default) and **paper** (light),
each authored separately rather than derived, because a light-theme tint
needs about half the alpha of a dark one to read the same.

Colour is a controlled vocabulary, one meaning each: **coral** for selection,
the primary action and focus; **green** for a cryptographic fact or someone
being here right now; **amber** for a guarantee that is reduced or unchecked;
**red** for broken or irreversible. The monospace carries the system's voice —
labels, timestamps, counts, epochs, statuses, security lines — but never a
person's name, body copy, or a button label. Member avatars are **mesh orbs**
(`src/lib/avatar.js`): hashed hue blobs blurred into one wash, derived from
the handle and never uploaded, because identity here is a key. Chrome layout:
a full-width
masthead (brand · circle + epoch · invite · ⌘K palette · theme · relay
state), a single sidebar (circles → rooms → voice → self card), the
conversation (grouped messages, day dividers, hover timestamps), and the
roster. `Ctrl/⌘-K` opens a command palette (rooms, circles, actions).
All icons are inline SVG (`src/components/icons.jsx`) — no fonts, no CDN.

**Mobile** (≤820px): the same components, a different floor plan — the
conversation owns the screen and the sidebar/roster become edge drawers
(menu and roster toggles appear in the masthead; the invite action moves
into the palette). Touch devices get bigger targets, surfaced
hover-affordances, 16px inputs (so iOS doesn't zoom the page on focus),
`dvh` heights and safe-area insets for notches and home bars. The client
ships a web manifest plus generated icons (`scripts/gen-icons.mjs`,
outputs committed under `public/icons/`), so it installs to the home
screen as a PWA; the service worker for push already registers at boot.

**UI gallery**: `npm run preview:ui` serves `/preview.html`, which renders
the real components against mock state (no relay, no WASM) — views:
`?view=app|onboarding|invited|empty|banner|palette|modal-*`, plus
`&theme=paper`. Useful for design review and screenshots when the crypto
core isn't built.

`npm run shots:ui` walks the whole gallery and writes 42 PNGs to `SHOT_DIR`
(default `/tmp/ui`) — every view, both themes, desktop and phone, at 2×. The
phone context sets `hasTouch`, which is load-bearing: without it
`@media (hover: none)` never matches and the shot shows a layout no phone
user will ever see.

### Invite links

`?j=<invite-id>#k=<key>` — the invite id is server-visible; the AES-GCM
key rides in the fragment, which browsers never transmit. Creating an
invite exports the group's signed GroupInfo (ratchet tree included),
encrypts it under a fresh fragment key, and parks it on the relay with a
7-day expiry. Redeeming decrypts the blob and joins by **External Commit**
(RFC 9420 §12.4) — no existing member needs to be online. GroupInfo dies
with its epoch, so the invite creator re-encrypts and re-uploads after
every membership change; if they're offline too long the link goes stale
until they return. Link-joined members carry a persistent
"via link · unverified" badge in the member list until safety numbers
land (Phase 5).

### Identity storage

The identity bundle lives in **two places**: the full MLS state snapshot
in IndexedDB (groups + ratchets, same device only) and the identity key
alone in localStorage. If IndexedDB is wiped, boot falls back to the
localStorage identity: the account survives, group keys don't, and the UI
says exactly that. The identity key is also exportable from the UI as a
plain string (copy or download — labeled loudly, since whoever holds it
IS you) and importable by pasting on the onboarding restore screen.

### Attachments

Files are AES-GCM-encrypted in the browser under a random per-file key,
uploaded to the relay's disk under a random capability id, and the key
rides inside the MLS message envelope (`{k:'file', ch, file}`). Receivers
fetch the ciphertext and decrypt locally — images render inline, other
files decrypt on click. The relay stores bytes it cannot read.

### Safety numbers

Click a member: both sides derive the same 60 digits from the pair's MLS
identity keys (the keys that sign every message). Compare out of band,
mark verified — stored on this device only. Verification replaces the
"via link · unverified" badge with "✓ verified".

### Notifications (Web Push)

`sw.js` handles `push`/`notificationclick`; the "alerts" button asks for
permission, subscribes via the relay's VAPID key, and hands the
subscription over `push_subscribe`. The relay nudges this device only
while it's offline, with a generic encrypted payload (no content — the
server never has any). iOS Safari: installed-PWA only, per the plan.

### Voice channels (audio mesh)

Each server has voice channels (default `lounge`). Audio-only mesh: every
participant holds a pairwise `RTCPeerConnection` to every other (the
lexicographically smaller name offers — no glare), viable to ~6–8 people;
a 1:1 call is just a two-person channel. All signaling — presence
(`join`/`here`/`leave`/`probe`) and SDP/ICE — travels as MLS-encrypted
**ephemeral** messages: the relay fans them out but never logs them and
cannot read them, so the DTLS fingerprints inside the SDP arrive over an
authenticated channel. That is the fingerprint verification: a relay that
tampered with signaling would fail MLS authentication. Media itself is
DTLS-SRTP peer-to-peer; the relay never touches it. On a membership
change, remaining participants drop connections to anyone kicked. Without
a microphone the client joins listen-only (silent WebAudio track).
Default STUN is Google's; real deployments behind symmetric NATs need
their own STUN/TURN (TURN sees ciphertext only, per the plan).

### Accounts: passkeys and passwords

Sign-in from a new device without moving files. Securing an account parks
the identity bundle on the relay, encrypted client-side:

- **Passkey (recommended)**: WebAuthn registration + the PRF extension —
  the passkey deterministically derives the wrap key. Phishing-resistant,
  nothing brute-forceable stored anywhere, and synced passkeys make it
  portable across the user's devices.
- **Password**: Argon2id (in the crypto WASM) yields 64 bytes — the auth
  half is sent (server stores only its hash), the wrap half encrypts the
  bundle locally. The honest caveat: the relay could brute-force *weak*
  passwords offline against the blob.

Invite-link joiners skip the recovery gate entirely (handle → in the
group in seconds) and get a persistent banner until they secure the
account by any method (passkey, password, or key-file download). Signing
in restores identity, never message history.

### Recovery scope (honest version)

The recovery key protects the **identity key** — the thing the relay has
pinned; losing it loses the account name forever. It deliberately does
not snapshot group ratchet state: a stale ratchet can't decrypt anything
newer anyway. After a restore you keep your identity and get re-added.
Same-device reloads are the IndexedDB snapshot's job, not recovery's.

## Run & test

```sh
../crypto-core/build-wasm.sh    # WASM first
cargo build -p relay            # e2e spawns target/debug/relay
npm install
npm run build
npm run e2e                     # full journey, two browser profiles
```

The e2e covers: onboarding with the recovery gate, server + channel
creation, add-by-handle, encrypted chat both directions, the no-scrollback
assertion (pre-join message must NOT appear for the joiner), reload with
IndexedDB state (history intact and ratchets live), and identity restore
in a fresh profile. `CHROMIUM_PATH=/path/to/chrome` overrides the browser.
`node e2e/screenshot.mjs` renders a demo session to a PNG.

For interactive dev: `cargo run -p relay` in one shell, `npm run dev` in
another (the dev server proxies nothing — the client connects straight to
`ws://localhost:9601/ws`, override with `?relay=`).
