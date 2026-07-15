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

## Phase 1 (current)

Two browser tabs exchanging MLS messages via a stub relay. No UI.

The hard part is **not** the crypto — it's epoch management under
unreliable clients: state reconciliation, out-of-order delivery, missed
commits, orphaned proposals, a client returning after the group advanced
hundreds of epochs. That logic lives here and gets tested here.
