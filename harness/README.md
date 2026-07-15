# harness

Browser test surface: proves the WASM crypto core works in real browsers
against the real relay (`../relay/`). **Not the product** — the real
client is Phase 3 (`../client/`).

- `serve.mjs` — static server for the page and `../crypto-core/pkg/`.
- `worker.js` — Web Worker owning the MLS client; the main thread never
  sees key material, only ciphertext blobs and decrypted events.
- `app.js` / `index.html` — bare page speaking the relay protocol:
  challenge-response auth signed by the MLS identity key, KeyPackage
  publish/fetch, Welcome handling, subscribe, send.
- `e2e.mjs` — the milestone test: two Chromium tabs, alice creates,
  bob joins via KeyPackage → Welcome, both exchange encrypted messages,
  epochs asserted to converge.

## Run

```sh
../crypto-core/build-wasm.sh   # once, or after core changes
cargo build -p relay           # the e2e spawns target/debug/relay
npm install
node e2e.mjs                   # automated two-tab test (in-memory store)
DATABASE_URL=postgres://… node e2e.mjs   # same, against postgres
```

If Playwright's downloaded browsers don't match the environment, point at
a system Chromium: `CHROMIUM_PATH=/path/to/chrome node e2e.mjs`.

## Poke at it manually

```sh
cargo run -p relay &
node serve.mjs &
```

Open `http://127.0.0.1:9600/?name=alice&role=create` in one tab and
`http://127.0.0.1:9600/?name=bob&role=join` in another, and type.
