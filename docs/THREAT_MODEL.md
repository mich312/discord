# quorum — threat model

A maintained artifact, not prose. Review it on every release and whenever a
component's trust boundary moves. Phase 7 of `HARDENING_PLAN.md` calls for
this; it is the document an external reviewer should be handed first.

Written against the branch that closed Phases 0 and 1, and revised for the
change that moved the conversation onto the relay — see §1, which is where
that shows up.

---

## 1. What is being protected

**The primary asset is message plaintext**, and everything that decrypts it:
the per-channel room keys, MLS group state, the identity key, the account
vault, and the circles backup.

**The primary guarantee** is that a relay operator — including one who is
compromised, coerced, or malicious from the start — cannot read message
content or join a group.

Everything else in this document is secondary to whether that holds.

**What that guarantee no longer includes.** Message content used to be
forward-secret: it existed on the devices that were present, and the
relay's copy was an opt-in convenience. The relay now holds every
channel's conversation, sealed under a room key the whole roster has. The
operator still cannot read it — but the ciphertext is all in one place,
one leaked room key opens everything that key ever covered, and anyone
admitted to a circle can read its past. That is a deliberate trade for a
product where a new device, a new member and a fresh sign-in all see the
same room. It is the single largest change to this document, and §5
carries it as an accepted risk rather than a footnote.

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
 │    │ postMessage        │   cursors + verifications (IndexedDB)
 │  Web Worker  ── WASM ───┼── MLS state, ratchets
 └────────────┬────────────┘
              │  TLS         ↑ the device holds keys. Circles — names,
 ┌────────────┴────────────┐   rooms, settings, room keys — are fetched
 │ relay: ordered log      │   from the relay and held in memory only.
 │ Postgres · blob store   │   ciphertext + metadata. Never plaintext.
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
| **T** | Forged log entries | **Mitigated.** Each entry carries an Ed25519 signature by its author's MLS identity key, bound to the entry's circle and log id, checked against a key directory built from the MLS roster rather than from anything the relay says. An entry that fails is dropped; one that cannot be attributed (written before signatures, or by a member whose key this device never learned) renders marked and never shares a header with one that can. Mutations — edit, delete, react — apply only when verified. |
| **T** | A room-key holder rewrites someone else's line | **Mitigated.** An edit or deletion applies only to a line by the same signed author, so the signature is the ACL. |
| **I** | A removed member reads what the circle says next | **Mitigated.** Removal rotates every room key; superseded keys are kept for reading, never dropped, since they are the only thing that opens the messages written under them. |
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
| **I** | Metadata: social graph, timing, group sizes, handles, push endpoints | **Accepted, documented.** This is the design's central cost, and it grew: the relay now holds every channel's log, so it also sees how much each channel holds, when each entry landed, and — recorded deliberately — which member appended it. That last is what authorizes a deletion and answers "what have I missed" without the device downloading every channel. The relay saw all three at write time regardless; what changed is that authorship is now durable, so a database dump maps entries to speakers. |
| **D** | A client is made to download an unbounded log | **Mitigated.** Reads are paged and the page size is clamped server-side. |
| **D** | Withhold the circles blob and the account has no circles at all | **Accepted, and newly true.** A circle's shape and room keys now live only in the relay-parked blob, so a relay that authenticates a connection but refuses `backup_get` leaves the client with nothing to show — where before the device held its own copy and could at least render the rooms. This is the availability half of the same bargain the log already made: the relay is the archive, and an archive that will not answer is indistinguishable from an empty one. What it still cannot do is *lie*: the blob is sealed client-side, so it can withhold circles but not invent, alter or read them. The client refuses to write a backup until it has read one, so a withheld read cannot be escalated into a destroyed backup. |
| **T** | Roll a user back to an older circles blob | **Accepted.** The relay stores the blob and its version and could serve a stale pair, un-joining a circle or reviving a deleted room on the next device that reads. Detecting it needs a signed, monotonic counter the relay does not hold — the same shape of problem as reordering the log, and unfixed for the same reason. |
| **E** | Redact another member's entry | **Mitigated.** Authorship is checked inside the delete predicate, not by a prior read — so it neither races a concurrent write nor becomes an oracle for who wrote what. Admins may redact any entry in their circle. |
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
| **I** | Room keys readable at rest on a stolen device | **Narrowed.** They are no longer written to IndexedDB: a circle's room keys live in the relay-parked blob and are held only in memory for the session. This is a smaller win than it looks — the identity key in localStorage opens that blob (6.3), so a full image of a live device still yields everything. What it removes is the weaker case: an image of a device whose localStorage was evicted, or whose IndexedDB was recovered on its own. |
| **T** | A service worker outlives the page and re-serves a targeted bundle | **Narrowed, newly relevant.** The offline shell caches app code, so code delivery now has a persistent component. `sw.js` is never cached (it must be able to replace itself); `index.html` is network-first, so a targeted payload survives only until the next successful online navigation; assets are content-hashed and the cache is version-scoped, so nothing outlives its deploy. Search results and message content are never cached — only the shell. |
| **D** | Attachments fill the origin quota via the shell cache | **Mitigated.** Nothing is cached at runtime; the precache list is fixed at build time and excludes `/blob/`. |

### Voice

| | Threat | Status |
|---|---|---|
| **I** | Every call peer learns every other peer's IP | **Mitigable, opt-in, and now stated.** Settings → call privacy sets `iceTransportPolicy: 'relay'`, so peers see the TURN server instead of you. Three honest limits, all in the UI: it needs the operator to have configured TURN (the policy is applied regardless, so it *fails* rather than silently leaking); it hides your address, not theirs, unless they enable it too; and it applies to the next call, not one in progress. The TURN operator sees the media flow, though not its plaintext. |
| **D** | Mesh collapse past ~8 participants | **Narrowed.** `MESH_LIMIT` refuses the ninth join before capturing the mic, and the button reads "full". Client-side and so advisory — media is peer-to-peer and simultaneous joins can both see room. |

## 5. Explicitly accepted risks

These are design decisions with costs, not unfixed bugs. Each is stated in
the README and `SECURITY.md`.

1. **Metadata is visible to the relay.** Who, when, how often, group sizes,
   call participation, push provider.
2. **Web code delivery.** The operator serves the client and can target one
   user. CSP, SRI, the worker's wasm integrity check and the published
   `integrity.json` narrow it — they catch the crypto core being wrong on its
   own, and give an outside party something specific to verify. None of them
   defends against the operator, who serves the checks too.
   **Builds are now reproducible** on a pinned toolchain across independent
   machines (CI proves it per commit), so a third party *can* rebuild the
   source and compare against what is served — which is the mechanism that
   turns a targeted bundle into something detectable. It is not yet
   demonstrated off one runner image, and nobody is doing the comparison
   routinely; a packaged, signed client would still be stronger.
3. **There is no forward secrecy for message content.** Every channel keeps
   its conversation on the relay under a room key the roster holds. Anyone
   admitted later reads the past; one leaked key opens everything it ever
   covered. Per-channel auto-delete is the only bound, and it is enforced
   by the relay deleting entries — honest-weak in the same way invite-link
   controls are. Removal rotates keys forward, which protects what is said
   next and nothing that was said before.
4. **Deleting is not erasure for readers who were there.** The relay drops
   the entry and every reader folds a tombstone over it, so a later joiner
   cannot read it with the room key — but a device that already fetched the
   line keeps it, and nothing on the relay can reach into that. Stated at
   the button.
5. **Invite-link controls are server-enforced** and so bypassable by a
   malicious relay. Membership is not.
6. **Password vaults are offline-grindable** by the server for weak
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

`SHA-256("quorum-circles-backup-v1" ‖ identity)` opens the circles blob,
which carries every channel's room key. One compromise of the identity — a
stolen device, an XSS, a cracked weak password — retroactively unlocks
every channel in every circle. **There is still no rotation.**

This got worse, not better, and deliberately so. When the relay held only
the channels that opted into kept history, the identity key unlocked those.
It now unlocks every conversation the account is in, all of which sit on the
relay in one place — and since the blob became the only copy of a circle's
room keys rather than a spare, the identity key is not merely *a* way in, it
is the way in. Identity key rotation plus per-channel re-keying was
already the fix; it is now the highest-value unscheduled work in this
document, and the ranking below reflects that.

Device revocation now exists, and is **forward-only by decision**. Each
enrolled device holds the identity sealed under its own passkey's PRF
secret; revoking deletes that wrap, so the passkey can no longer unlock the
identity from the relay. Be precise about the two halves:

- **What it defeats.** A credential that outlives the hardware. For a
  *synced* passkey — iCloud Keychain, Google Password Manager — that is the
  normal case, not the exotic one: without revocation a recovered or cloned
  keychain keeps pulling the identity down indefinitely.
- **What it cannot touch.** A device that already holds the identity in
  local storage. Nothing running on the relay can reach into it, so a
  device lost while signed in keeps the room keys it holds — and with them
  every conversation those keys open, as far back as retention allows. The
  UI says so at the button rather than in a help page.

So revocation narrows the window, and does not close §6.3. Closing it needs
identity key rotation plus per-channel history re-keying, which is a
separate piece of work and is not scheduled.

Two properties of the revocation surface itself, both covered by tests in
`relay/tests/account_http.rs`. The device list is metadata only — the type
it returns has no field for the wrap, so the endpoint cannot leak the sealed
identity even if a handler forgot to strip it. And deletion is scoped to the
owner inside the SQL predicate rather than by a prior read: a credential id
is disclosed by the passkey challenge, so a read-then-check would both race
a re-enrolment and put "is this id enrolled?" one bug away. An unknown
device and somebody else's are answered identically, so the endpoint is not
an enrolment oracle.

## 7. Non-goals

Not defended against, deliberately: a compromised endpoint device beyond
what post-compromise security gives; global passive adversaries correlating
traffic; a malicious *member* screenshotting or exfiltrating content they
can legitimately read — which now means a circle's whole past, not just
what arrived while they were in it; availability against a determined
operator (they can simply stop serving).

## 8. Review triggers

Revisit this document when any of these change: the ciphersuite; how the
client is delivered; where the identity key lives; the account/vault flow;
anything touching room keys, the key directory, or what a log entry's
signature covers; what the relay records alongside a log entry; the
addition of any server-side feature that requires reading content.
