# crypto-core

Rust + [OpenMLS](https://github.com/openmls/openmls), compiled to WASM.
Runs inside a Web Worker, off the main thread. The UI never touches keys
directly — all MLS state lives here.

**Do not write crypto.** OpenMLS provides the MLS (RFC 9420) implementation;
this crate wraps it for the product's needs:

- Identity + KeyPackage generation (pre-published per device)
- Group create / join (including **External Commits** for invite links)
- Message encrypt/decrypt against the group's current epoch
- Exporter-secret derivation (future: SFrame media keys for group calls)
- Key storage via non-extractable `CryptoKey` handles in IndexedDB,
  plus the passphrase-wrapped recovery-key export

## Phase 1 (done)

Two browser tabs exchange MLS messages via a stub relay (see
[`../harness/`](../harness/)). No UI.

The hard part is **not** the crypto — it's epoch management under
unreliable clients: state reconciliation, out-of-order delivery, missed
commits, orphaned proposals, a client returning after the group advanced
hundreds of epochs. That logic lives here and gets tested here.
`tests/mls_flow.rs` already covers the first cases (commit overtaking a
message, removed member locked out); the deeper reconciliation work
continues alongside Phase 2.

## Layout

- `src/client.rs` — pure-Rust `ChatClient` (all MLS logic; natively testable)
- `src/wasm.rs` — thin `#[wasm_bindgen]` wrapper, wasm32-only
- `tests/mls_flow.rs` — native integration tests over serialized blobs

Groups run `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` with the
ratchet-tree extension (self-contained Welcomes) and retain 2 past epochs
of decryption secrets so a commit overtaking an in-flight message doesn't
drop it.

## Build & test

```sh
cargo test          # native integration tests
./build-wasm.sh     # wasm-pack build --target web → pkg/
```

Needs `rustup target add wasm32-unknown-unknown` and `wasm-pack`.
`wasm-opt` (binaryen ≥ 116) is optional — the script skips older versions
because they miscompile modules from current rustc.
