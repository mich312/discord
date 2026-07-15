# Encrypted Group Chat — Build Plan (Web MVP)

## 1. Positioning

**What it is:** small, persistent, invite-only groups (10–50 people) formed around something specific — a race team, a photo club, a project. Discord's skeleton, Signal's social model.

**What it isn't:** a public server you stumble into. End-to-end encryption forbids scrollback for new members, so dropping into a busy public room shows an empty channel. Any positioning that depends on lurking-then-joining is structurally impossible.

**The trade, stated plainly:** the differentiator (encryption) is invisible; the costs (no history, no server search, no moderation) are visible. This works for groups that already want to be private. It does not work as a general Discord replacement.

---

## 2. Non-negotiable consequences of E2EE

| Constraint | Why | Product answer |
|---|---|---|
| No scrollback for new joiners | Sharing history means sharing old keys → kills forward secrecy | Permanent "you joined here" watermark at top of channel |
| No server-side search | Server holds ciphertext only | Client-side index; label it "searching this device" |
| No content moderation | Server can't read anything | User reports + message franking (WhatsApp scheme) for provable origin |
| No cross-device history sync (MVP) | Each device is its own MLS leaf | Accept it; per-device local store |
| Metadata is not hidden | Server sees who talks to whom, when, how often | Say so in the docs. Don't overclaim. |

---

## 3. Core decision: MLS

Use **MLS (RFC 9420)** via **OpenMLS** (Rust) or AWS **mls-rs**. Do not write crypto.

MLS is built for exactly this shape:
- Dynamic membership with O(log n) key updates
- Forward secrecy + post-compromise security
- **External Commits (§12.4)** — a joiner can add themselves using a `GroupInfo` blob with no existing member online. This is what makes invite links possible at all.
- **Exporter secret** — derives media keys for encrypted calls for free. Membership change → call rekeys automatically.

Everything downstream follows from this choice.

---

## 4. Architecture

| Layer | Choice | Notes |
|---|---|---|
| Crypto core | Rust + OpenMLS → **WASM** | Runs in a Web Worker, off the main thread |
| UI | SvelteKit or React | Never touches keys directly |
| Relay | Rust (axum) or Go, WebSocket | Dumb ordered log + fan-out. Stores opaque blobs. |
| Relay DB | Postgres — blobs keyed by `(group_id, epoch, seq)` | Server never sees plaintext |
| KeyPackage store | Server-hosted, pre-published per device | Enables async member addition |
| Attachments | Random AES-GCM key per file → R2/S3; key travels inside the MLS message | Standard |
| Static hosting | Cloudflare Pages | Already in your stack |
| 1:1 calls | Raw WebRTC, DTLS-SRTP | Already E2EE. TURN relay sees ciphertext only. |
| Group calls | LiveKit self-hosted + SFrame (RFC 9605) via `RTCRtpScriptTransform` | Keyed from MLS exporter secret |
| Push | Web Push + service worker | Android/desktop fine. iOS Safari: installed PWA only, flaky. |

### Server role, precisely

The relay is a **delivery service and ordered log**. It authenticates connections, stores ciphertext, enforces ordering within a group, hosts KeyPackages, and fans out. It cannot read messages, cannot read group membership contents, cannot read invite blobs. It *can* observe metadata and it *can* lie about who it delivers to — which is why membership is verified cryptographically client-side, not trusted from the server.

---

## 5. The web-specific problems

### 5.1 Code delivery is the weak point

The server ships the crypto on every page load. A compromised server, CDN, or CI pipeline can serve a poisoned bundle to one targeted user and exfiltrate keys. This is the standard and correct critique of browser E2EE. It cannot be eliminated, only mitigated:

- Subresource Integrity on every asset
- Strict CSP, no `unsafe-inline`, no `unsafe-eval`
- Public reproducible build with published hashes
- Optional: a browser extension that pins the expected bundle hash (this is what the serious deployments do)

None of this stops a targeted attack. It makes a *silent, broad* attack much harder. State this honestly in the security docs.

### 5.2 Key storage

- **Non-extractable `CryptoKey` in IndexedDB.** The browser holds the private key; JS can use it but never read it. This is the good path and it's genuinely decent.
- **But storage is evictable.** Safari ITP clears IndexedDB after ~7 days of no interaction. Clear-site-data wipes it. No OS-level backup exists.
- **Therefore:** call `navigator.storage.persist()`, *and* force an exported recovery key at onboarding — a passphrase-wrapped bundle the user must save. Not optional, not skippable. Losing keys means losing every group permanently.

The recovery key flow is a real screen with real friction. Budget for it.

---

## 6. Invite links

### URL shape

```
https://app.example/j/7f3a9c2e#k=Yk9sM3Rmb2xrZXk...
```

- **Path** (`7f3a9c2e`) — opaque invite ID. Server sees this. Lookup key, nothing more.
- **Fragment** (`#k=...`) — symmetric key. **Never transmitted.** Browsers don't send fragments in requests: not in logs, not in `Referer`, not to the CDN.

Server stores `GroupInfo` encrypted under the fragment key. It serves a blob it cannot read. Client fetches → decrypts in the Worker → external commit → in the group.

This is the one place web-only is strictly better than native: click → tab → you're in. No install, no store, no deferred deep-link plumbing.

### The link is a bearer token

Whoever holds it is a member. That's a genuine weakening and it must surface in the UI, not hide in a warning:

- Link-joined members are marked **unverified** in the member list until someone checks their safety number. Persistent and quiet, not a dismissible banner.
- Existing members see joins as **inline system messages** with the new member's fingerprint. The member list is the security boundary; a stranger appearing in it is an event.
- Optional for sensitive groups: **admin approval queue** — external commit lands them in pending; real addition on approval.

### Controls, and their honest strength

| Control | Mechanism | Enforced by |
|---|---|---|
| Expiry | Server refuses blob after `expires_at` | Server (weak) |
| Max uses | Server-side counter | Server (weak) |
| Revoke link | Delete blob **and rotate epoch** | Server + crypto |
| Kick member | Remove proposal + commit → new epoch | Crypto (strong) |

The asymmetry matters: link controls are server-enforced and a malicious server can bypass them. **Membership is cryptographically enforced and it cannot.** An attacker with server access can hand the blob to anyone — but without the fragment they still can't read it. Don't conflate the two in the docs or the UI.

### Where links fail

A link into an active channel opens onto an empty room with a watermark. The newcomer gets zero context. Invite links are for **assembling** a group, not **growing** one. Design accordingly.

---

## 7. Interface

### Layout

Discord's three columns — server rail → channel list → messages — but the rail holds 3–6 servers, not 40. Channels within a server are cheap and disposable.

### Load-bearing UI that Discord doesn't have

- **Member list is primary, not a sidebar afterthought.** In E2EE the member list *is* the security boundary: it's who can read this.
- **Join-time watermark** — permanent line, once per channel, not an error state.
- **Safety numbers per member**, not per conversation. Tap a member → device fingerprints → verify.
- **Device list** as a first-class settings screen. A new device is a new reader of everything.
- **Scoped search** — "searching messages on this device" as a persistent label.
- **Recovery key status** — visible, nagging until saved.

### Visual register

Not Discord's blurple-and-emoji playfulness. The people who accept these tradeoffs are choosing deliberateness. Quiet palette, real typography, density without noise — closer to a well-made instrument than a lobby. Same sensibility as the topographic-contour portfolio work. This reads as more credible than a Discord clone in different colors, and it's cheaper to execute well.

### Screens (MVP total: 6)

1. Server rail + channel list
2. Channel — messages, composer, attachments
3. Member list → member detail with verification
4. Server settings — invites, channels, leave
5. Device management + recovery key
6. Onboarding — identity creation, recovery key export

**Explicitly cut:** profiles, reactions, threads, status/presence, roles beyond admin/member. Each multiplies epoch-management complexity and none is why anyone would switch.

---

## 8. Build order

| Phase | Work | Weeks |
|---|---|---|
| 1 | Rust core + OpenMLS → WASM. Two browser tabs exchanging MLS messages via stub relay. No UI. | 2–3 |
| 2 | Relay: auth, KeyPackage store, ordered delivery, epoch handling | 2 |
| 3 | Web client: rail, channels, messages, IndexedDB, recovery key flow | 3 |
| 4 | Invite links: encrypted GroupInfo blobs, external commits, unverified-member UI | 1 |
| 5 | Attachments + safety numbers UI | 1 |
| 6 | Web Push + service worker | 1 |
| 7 | **1:1 WebRTC calls** — signaling over existing relay, fingerprint verified via MLS identity | 2 |
| 8 | Group calls: LiveKit + SFrame from exporter secret | 3+ |

**Phases 1–7 are a coherent, shippable product.** Phase 8 is where the infrastructure bill starts.

### Phase 1 is where this lives or dies

Not because the crypto is hard — OpenMLS handles that. Because of **epoch management under unreliable clients**: a browser tab closed for three weeks rejoining a group that has advanced 400 epochs. State reconciliation, out-of-order delivery, missed commits, orphaned proposals. This is where the real time goes and it appears in no spec. If phase 1 takes six weeks instead of two, that's the reason, and it's normal.

---

## 9. Voice: the scoping question

1:1 is nearly free in the browser — WebRTC is already E2EE, you build signaling and use existing NAT traversal. Two weeks.

Group is a different product. Mesh dies at ~4 participants. An SFU terminates DTLS-SRTP, so it decrypts — hence SFrame as a second layer inside the media, keyed from the MLS exporter secret. Elegant in the browser (`RTCRtpScriptTransform` in a Worker, a few hundred lines; LiveKit's SDK ships E2EE mode built on exactly this).

The cost isn't the code, it's everything around it:

- **Infra shape changes.** A 20-person call is ~20+ Mbps egress. This is bandwidth, not requests. Hetzner-VPS-shaped hosting does not cover it.
- **Metadata leaks fully.** The SFU knows who called whom, when, for how long.
- **It's ongoing cost**, not a one-time build.

### The uncomfortable question

Voice *is* Discord. Text is the lobby; the product is people sitting in a channel for four hours. A Discord-like without voice isn't a lean MVP of Discord — it's Signal with a server rail.

So decide before phase 1:

- **Encrypted small-group text** → ship through phase 7 and stop. The MLS work is the whole product. Coherent, finishable, cheap to run.
- **Actually Discord** → voice is the MVP and text is the sideshow. Different build order, infra bill starts day one, and the paths only share ~40% of the work.

---

## 10. Honest assessment

This is a large greenfield build in a domain where:
- The differentiator is invisible to users
- The costs are visible on the first screen
- The incumbent is free and has a decade of network effects
- The hardest engineering (epoch reconciliation) produces zero user-facing feature

As a **deliberate learning project on MLS**, it's excellent — MLS is genuinely important, under-implemented, and the skills transfer.
