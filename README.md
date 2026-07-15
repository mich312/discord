# Encrypted Group Chat

Small, persistent, invite-only groups (10–50 people) formed around something
specific — a race team, a photo club, a project. **Discord's skeleton,
Signal's social model.**

This is not a public server you stumble into. End-to-end encryption forbids
scrollback for new members, so any positioning that depends on
lurking-then-joining is structurally impossible. The differentiator
(encryption) is invisible; the costs (no history, no server-side search, no
content moderation) are visible. That trade works for groups that already
want to be private — it does not work as a general Discord replacement.

The full design and phased build order live in
**[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)**. Read it before touching
anything — every architectural choice downstream follows from the decision
to build on **MLS (RFC 9420)**.

## Architecture at a glance

| Component | Directory | Stack |
|---|---|---|
| Crypto core | [`crypto-core/`](crypto-core/) | Rust + OpenMLS, compiled to WASM, runs in a Web Worker |
| Relay | [`relay/`](relay/) | Rust (axum), WebSocket; dumb ordered log + fan-out over opaque blobs; Postgres |
| Web client | [`client/`](client/) | React + Vite; UI never touches keys (crypto worker + IndexedDB) |
| Test harness | [`harness/`](harness/) | Bare browser page + two-tab Playwright e2e against the real relay (no product UI) |

The relay is a **delivery service and ordered log**, nothing more: it
authenticates connections, stores ciphertext keyed by
`(group_id, epoch, seq)`, hosts pre-published KeyPackages, enforces
per-group ordering, and fans out. It cannot read messages, membership, or
invite blobs. It *can* observe metadata — who talks to whom, when, how
often — and the docs say so plainly rather than overclaiming.

## Build order

| Phase | Work | Status |
|---|---|---|
| 1 | Rust core + OpenMLS → WASM; two browser tabs exchanging MLS messages via stub relay | **done** |
| 2 | Relay: auth, KeyPackage store, ordered delivery, epoch handling | **done** |
| 3 | Web client: rail, channels, messages, IndexedDB, recovery-key flow | **done** |
| 4 | Invite links: encrypted GroupInfo blobs, external commits, unverified-member UI | **done** |
| 5 | Attachments + safety-numbers UI | **done** |
| 6 | Web Push + service worker | **done** |
| 7 | Voice: 1:1 + audio mesh voice channels (≤~8), E2EE signaling over the relay | **done** |
| 8 | Large group calls: LiveKit + SFrame keyed from the MLS exporter secret | not started — mesh covers small groups; SFU only if channels outgrow it |

Phases 1–7 are a coherent, shippable product. Phase 8 is where the
infrastructure bill starts.

**Phase 1 is where this lives or dies** — not the crypto (OpenMLS handles
that) but epoch management under unreliable clients: a tab closed for three
weeks rejoining a group that has advanced 400 epochs. If Phase 1 takes six
weeks instead of two, that's the reason, and it's normal.

## Open decision (blocks Phase 1)

The plan poses one scoping question that must be answered before writing
code (see [§9 of the plan](docs/BUILD_PLAN.md#9-voice-the-scoping-question)):

- **Encrypted small-group text** → ship through Phase 7 and stop. Coherent,
  finishable, cheap to run.
- **Actually Discord** → voice is the MVP and text is the sideshow.
  Different build order, infra bill from day one, only ~40% shared work.

The current phase ordering assumes the first answer.
