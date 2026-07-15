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
