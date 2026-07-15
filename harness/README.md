# harness

Phase-1 test surface: proves the WASM crypto core works in real browsers
with MLS blobs flowing through a dumb relay. **Not the product** — the real
relay is Phase 2 (`../relay/`), the real client Phase 3 (`../client/`).

- `relay.mjs` — stub relay: WebSocket fan-out of JSON envelopes
  (`{type, from, to?, payload}`); the MLS payload stays opaque base64.
  Addressed delivery for Welcomes, broadcast for everything else.
- `serve.mjs` — static server for the page and `../crypto-core/pkg/`.
- `worker.js` — Web Worker owning the MLS client; the main thread never
  sees key material, only ciphertext blobs and decrypted events.
- `app.js` / `index.html` — bare page: status line, log, composer.
- `e2e.mjs` — the milestone test: two Chromium tabs, alice creates,
  bob joins via KeyPackage → Welcome, both exchange encrypted messages,
  epochs asserted to converge.

## Run

```sh
../crypto-core/build-wasm.sh   # once, or after core changes
npm install
node e2e.mjs                   # automated two-tab test
```

If Playwright's downloaded browsers don't match the environment, point at
a system Chromium: `CHROMIUM_PATH=/path/to/chrome node e2e.mjs`.

## Poke at it manually

```sh
node relay.mjs &
node serve.mjs &
```

Open `http://127.0.0.1:9600/?name=alice&role=create` in one tab and
`http://127.0.0.1:9600/?name=bob&role=join` in another, and type.
