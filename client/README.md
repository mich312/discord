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
- `src/lib/db.js` — IndexedDB: MLS state snapshot, server records,
  decrypted message history (per-device store; there is no server copy).
- `src/lib/recovery.js` — recovery key: identity bundle wrapped with
  PBKDF2-SHA256 (310k) → AES-256-GCM under a generated code.

### Servers and channels

One MLS group per server. Channels are routing *inside* the encryption —
message plaintext is a JSON envelope (`{k:'chat', ch, text}`,
`{k:'chan', ch}`, `{k:'meta', name, channels}`), so the relay never learns
channel structure or server names. Because joiners have no scrollback,
server metadata is rebroadcast (encrypted) after every member add.

### Load-bearing UI (per the plan)

- Member list is the security boundary — labeled "who can read this",
  with add-member right there, and epoch visible in the header.
- Permanent join watermark at the top of every channel.
- Composer states the encryption scope ("encrypted for N members").
- Onboarding cannot be completed without downloading the recovery file
  and confirming the code is stored off-device.

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
