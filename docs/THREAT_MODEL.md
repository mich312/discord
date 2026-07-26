# quorum — threat model

A maintained artifact, not prose. Review it on every release and whenever a
component's trust boundary moves. Phase 7 of `HARDENING_PLAN.md` calls for
this; it is the document an external reviewer should be handed first.

Written against the branch that closed Phases 0 and 1.

---

## 1. What is being protected

**The primary asset is message plaintext**, and everything that decrypts it:
MLS group state, the identity key, per-channel kept-history keys, the
account vault, and the circles backup.

**The primary guarantee** is that a relay operator — including one who is
compromised, coerced, or malicious from the start — cannot read message
content or join a group.

Everything else in this document is secondary to whether that holds.

## 2. Actors

| Actor | Capability assumed |
|---|---|
| **Relay operator** | Full read/write on the database, blob store, and every byte on the wire. Serves the client bundle. Can target one user. |
| **Network observer** | Sees TLS-wrapped traffic: timing, sizes, endpoints. Not content. |
| **Group member** | Holds current group keys. May be malicious or later removed. |
| **Removed member** | Held group keys until epoch N. Should hold nothing useful after. |
| **Stranger** | No account. Can reach every unauthenticated endpoint. |
| **Device thief / forensic imager** | Full read of one device at rest. |
| **Call peer** | Any participant in a WebRTC session. Learns IP addresses. |

## 3. Boundaries

```
 ┌──────── device ─────────┐
 │  UI thread              │   identity key (localStorage, plaintext)
 │    │ postMessage        │   ← boundary is porous by design; see 5.2
 │  Web Worker  ── WASM ───┼── MLS state, ratchets
 └────────────┬────────────┘
              │  TLS
 ┌────────────┴────────────┐
 │ relay: ordered log      │   ciphertext + metadata. Never plaintext.
 │ Postgres · blob store   │
 └─────────────────────────┘
              │  P2P (no relay)
        WebRTC media ──────────  IP addresses visible to peers
```

## 4. STRIDE, per component

### Crypto core (Rust → WASM)

| | Threat | Status |
|---|---|---|
| **S** | Relay substitutes a KeyPackage to join a group as a member | **Mitigated.** `add_member` binds the credential identity and the relay-pinned signature key. TOFU, not proof — see 6.1. |
| **S** | Verified ✓ survives a key change | **Mitigated.** Verification stores the safety number, re-checked on every membership change. |
| **T** | Forged kept-history entries | **Accepted.** Entries are authenticated by the room key, not per-sender signatures; any current or former key holder can forge one. Stated in the UI. |
| **I** | Ratchet state readable at rest | **Open.** Plaintext in IndexedDB. Plan §5.2 specified a non-extractable `CryptoKey`; never implemented. |
| **D** | Concurrent commits fork the group irrecoverably | **Mitigated.** Commits stage until the relay's epoch CAS accepts them. Groups forked *before* that fix stay forked. |
| **E** | Removed member retains future access | **Mitigated.** MLS re-key, plus history-key rotation and invite revocation on removal. |

### Relay

| | Threat | Status |
|---|---|---|
| **S** | Replay a captured auth signature as another user | **Mitigated.** The handle is bound into the signed challenge; `verify_strict`. |
| **S** | Hostile relay proxies a victim to the real one | **Mitigated.** `?relay=` is same-origin or loopback only; invite links no longer carry it. |
| **S** | Replay `password_login` to retrieve a vault | **OPEN.** No nonce. Yields Argon2id-sealed ciphertext, not an account. Three options in the plan; needs a decision. |
| **T** | Reorder or drop log entries | **Accepted.** The relay is the log; it can withhold. It cannot forge content or membership. |
| **R** | Operator denies serving targeted code | **Accepted and unfixable as designed.** See 6.2. |
| **I** | Read message content | **Mitigated by construction.** Ciphertext only. |
| **I** | Metadata: social graph, timing, group sizes, handles, push endpoints | **Accepted, documented.** This is the design's central cost. |
| **D** | Fill the disk via unauthenticated blob writes | **Mitigated.** Single-use upload tickets bound to one id. |
| **D** | Exhaust rate limits from one IPv6 allocation | **Mitigated.** Buckets keyed on the /64. |
| **D** | One busy circle starves the rest | **Mitigated.** Per-group send locks; the DB write left the global mutex. |
| **E** | Register unlimited accounts from one invite | **Mitigated.** The registration gate consumes a use, counted per claimant. |
| **E** | Re-point another user's passkey credential | **Mitigated.** Updates only apply to rows the caller owns. |
| **E** | Drain a user's KeyPackages so they cannot be added | **Mitigated.** `FetchKp` requires a registered target and refuses self-fetch. |

### Client

| | Threat | Status |
|---|---|---|
| **T** | Non-admin destroys local history via a forged envelope | **Mitigated.** Destructive envelopes fail closed. |
| **I** | Game iframe reads our origin's storage | **Mitigated.** `allow-same-origin` only for genuinely cross-origin frames. |
| **D** | Silent message loss on crash | **Mitigated.** Ratchet persists after the message and cursor. |
| **D** | Total data loss to WebKit's 7-day eviction | **Mitigated.** Persistence requested every boot, checked, and surfaced. |
| **I** | Identity key in localStorage | **Open.** Any script execution on the origin takes the account. |
| **T** | A service worker outlives the page and re-serves a targeted bundle | **Narrowed, newly relevant.** The offline shell caches app code, so code delivery now has a persistent component. `sw.js` is never cached (it must be able to replace itself); `index.html` is network-first, so a targeted payload survives only until the next successful online navigation; assets are content-hashed and the cache is version-scoped, so nothing outlives its deploy. Search results and message content are never cached — only the shell. |
| **D** | Attachments fill the origin quota via the shell cache | **Mitigated.** Nothing is cached at runtime; the precache list is fixed at build time and excludes `/blob/`. |

### Voice

| | Threat | Status |
|---|---|---|
| **I** | Every call peer learns every other peer's IP | **OPEN.** No `iceTransportPolicy: 'relay'` option, and nothing in the UI says so. |
| **D** | Mesh collapse past ~8 participants | **Narrowed.** `MESH_LIMIT` refuses the ninth join before capturing the mic, and the button reads "full". Client-side and so advisory — media is peer-to-peer and simultaneous joins can both see room. |

## 5. Explicitly accepted risks

These are design decisions with costs, not unfixed bugs. Each is stated in
the README and `SECURITY.md`.

1. **Metadata is visible to the relay.** Who, when, how often, group sizes,
   call participation, push provider.
2. **Web code delivery.** The operator serves the client and can target one
   user. CSP and SRI narrow it; only reproducible builds and a packaged
   client would close it.
3. **Kept history trades forward secrecy**, per channel, opt-in.
4. **Invite-link controls are server-enforced** and so bypassable by a
   malicious relay. Membership is not.
5. **Password vaults are offline-grindable** by the server for weak
   passwords. Passkey vaults are not.

## 6. Where the guarantee is weakest

Ranked by how much they undermine the primary guarantee.

### 6.1 Trust on first contact

KeyPackage binding checks against the key the *relay* pinned. A relay that
lies consistently from a user's first appearance still wins against anyone
who never compares a safety number. What the fix buys is that the lie is now
*consistent and detectable* — it moves the safety number, and the ✓ can no
longer survive it. Closing it fully needs out-of-band key distribution.

### 6.2 The operator is inside the TCB

Web-delivered E2EE means the operator ships the code that holds the keys, on
every page load, per user. This is categorically weaker than a signed native
client. It is the single largest gap and no amount of server hardening
touches it.

The offline shell adds a persistent cache to that delivery path. It does not
change the shape of the risk — an operator who can serve you targeted code on
one load can serve it on every load — but it does mean a payload can now
outlive the page that received it. The mitigations are structural rather than
policy: `sw.js` itself is never cached, so a hostile worker can always be
replaced; navigations go to the network first; and the cache is keyed on a
content hash of the shell, so it is discarded by the next deploy. Reproducible
builds remain the only real fix, for the same reason they were before.

### 6.3 The identity key is a master key

`SHA-256("quorum-circles-backup-v1" ‖ identity)` opens the circles backup,
which carries every channel's history key. One compromise of the identity —
a stolen device, an XSS, a cracked weak password — retroactively unlocks
every kept-history channel in every circle. There is no rotation and no
device revocation.

## 7. Non-goals

Not defended against, deliberately: a compromised endpoint device beyond
what post-compromise security gives; global passive adversaries correlating
traffic; a malicious *member* screenshotting or exfiltrating content they
can legitimately read; availability against a determined operator (they can
simply stop serving).

## 8. Review triggers

Revisit this document when any of these change: the ciphersuite; how the
client is delivered; where the identity key lives; the account/vault flow;
anything touching kept-history keys; the addition of any server-side feature
that requires reading content.
