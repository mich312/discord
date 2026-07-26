# quorum — Hardening & Production-Readiness Plan

Status: proposed. Written against `266d974`.

## Status

Everything below is green in CI. Sections further down keep the original
analysis; this is the current state.

### Complete

- **Phase 0** — all of §0.1–§0.8 except the `password_login` replay, which
  needs a decision rather than an implementation (see *Needs a decision*).
- **Phase 1** — §1.1–§1.8, including §1.1 part 4 (fork detection). The
  *automatic* recovery half of part 4 is open by decision, not by omission —
  see §1.1.
- **Phase 2** — §2.1 CI gate · §2.2 `applyEnvelope` + `AccountService` ·
  §2.3 the named coverage gaps · §2.4 image-based deploy with fast rollback ·
  §2.5 supply chain · §2.6 wasm integrity check, published hashes, and
  byte-for-byte reproducible builds enforced per commit across two machines
  (`docs/VERIFYING.md` is the third-party procedure).

### Partly done

| Phase | Done | Open |
|---|---|---|
| **3** | Per-group send locks (global hub mutex gone); hourly history sweep; recorded schema version with a rollback guard; bounded fan-out queues; opt-in blob TTL; published capacity limits | Message-log GC (design in §3.4); disk quotas; measured throughput |
| **4** | `/healthz`; connect/disconnect/subscribe logging; `deploy/RUNBOOK.md`; actionable WebAuthn config failure; token-gated Prometheus metrics; append-latency histogram; `deploy/alerts.yml` | OpenTelemetry tracing; SLOs |
| **5** | Dialog semantics + focus management on all overlays; WCAG AA contrast; iOS storage-eviction fix; drawer `aria-expanded`/`aria-controls` + labelled landmarks; 44px touch targets; `prefers-color-scheme` with a system-following default; rail unread badges; local message search; PWA offline shell; update notice; persistent kept-history indicator; voice participant cap | mention badges; iOS add-to-home-screen interstitial; wake lock; visualViewport; popstate |
| **7** | `SECURITY.md`; `docs/THREAT_MODEL.md`; epoch state-machine simulation harness (`relay/tests/epoch_model.rs`) | cargo-fuzz targets on protocol parsing (blocked on a toolchain decision, §7 below); commissioning the external review |

**Phase 6 is dropped** by decision — see *Decisions taken*. Device
revocation and identity key rotation were pulled out of it. **Revocation is
now done, forward-only by decision** (see below); identity key rotation
remains open.

### Needs a decision, not engineering

1. **`password_login` replay.** A server nonce does not fix it; the three
   real options and a recommendation are in §0.7 below.
2. **Commissioning the cryptographic review and penetration test.** Phase 7
   prepared the materials; engaging a firm needs a human and a budget.
3. **`libcrux-sha3` (RUSTSEC-2026-0207 and -0208).** Blocked upstream:
   `hpke-rs` pins `^0.0.8`. An earlier note here and in `deny.toml` called
   these unreachable "because libcrux arrives through post-quantum support";
   `cargo tree -e features` in CI shows the opposite — `libcrux-sha3` is an
   unconditional dependency of `hpke-rs` itself and `hpke-rs-libcrux` is not
   activated at all. The claim is withdrawn. Settling it means reading
   `hpke-rs` 0.6.1 to see whether it squeezes a SHAKE XOF on our classical
   path; -0207 is silently wrong output rather than a panic, so it is worth
   an hour of somebody's time. Only the cargo-deny advisories *step* is
   tolerated — the supply-chain job itself blocks again.

### Next, in order

1. Identity key rotation — the remaining half of §1.2's sibling work, and
   what §6.3 of the threat model actually needs. Device revocation landed
   forward-only; rotation plus per-channel history re-keying is what closes
   the master-key problem.
2. Automatic fork recovery — detection landed in §1.1 part 4; getting a
   current GroupInfo to a stranded device needs the decision recorded there.
3. Phase 7's fuzzing, once the nightly-toolchain question below is answered.
4. Phase 3's message-log GC (design and its hazard are in §3.4) and Phase 4's
   tracing.

---

This plan takes quorum from "impressive MLS learning project" to software you
could responsibly put in front of paying users. It is ordered by risk, not by
component, and every item names the file it touches and how you know it is done.

---

## 0. What "enterprise grade" means here — and the one conflict

Enterprise readiness is seven distinct properties. Six of them this codebase can
have without changing what it is:

| Property | Meaning here |
|---|---|
| **Security assurance** | The cryptographic guarantee actually holds against the stated adversary, and an external party has confirmed it |
| **Correctness** | No silent data loss, no unrecoverable states, no fail-open authorization |
| **Reliability** | Stated SLO, survives instance loss, degrades visibly rather than silently |
| **Scalability** | Throughput does not depend on a single global lock; capacity is known and documented |
| **Operability** | An on-call engineer can answer "why is this broken?" from telemetry alone |
| **Maintainability** | A new engineer can change the protocol without reading 2,500-line files |
| **Compliance** | Auditable controls, documented data handling, contractual guarantees |

The seventh — **compliance** — is where the conflict lives. Enterprise buyers
routinely require eDiscovery, legal hold, DLP scanning, content moderation, and
admin access to message content. Every one of those requires the server to read
plaintext. quorum's entire thesis is that it cannot. These are not hard problems
to be engineered around; they are mutually exclusive with the product.

**This plan therefore has two tracks:**

- **Tracks A–E (Phases 0–5)** — engineering quality. No conflict with E2EE.
  This is the bulk of the work and should proceed regardless.
- **Track F (Phase 6)** — enterprise product surface. Contains genuine forks
  that require a product decision. Marked ⚠ where a feature would weaken or
  void the encryption guarantee.

Phase 7 (assurance) applies to both.

---

## Phase 0 — Critical security. Nothing ships to real users before this.

**Target: 1–2 engineer-weeks. Blocks everything else.**

The current build has a hole through which a malicious or compromised relay
reads all traffic. Until 0.1 and 0.2 land, the README's central claim is false
and the product should not be represented as end-to-end encrypted.

### 0.1 Bind KeyPackages to identities ⛔ CRITICAL — DONE

`crypto-core/src/client.rs:292-297` validates a KeyPackage's self-consistency
and nothing else. It never checks that the embedded `BasicCredential` matches
the handle being added, nor that the KP's signature key matches the pubkey the
relay has pinned for that user. `client/src/lib/controller.js:1671-1678` feeds
the relay's `fetch_kp` response straight in. External commits accept any
credential outright (`|_| true`, `client.rs:445`), and `join_from_welcome`
(`client.rs:330-354`) validates nothing.

**Attack:** Alice clicks "add bob". The relay returns its own KeyPackage bearing
`BasicCredential("bob")`. The relay is now a cryptographic group member reading
everything from that epoch forward. The roster displays "bob".

**Fix:**
- Add an `expected_identity: &str` parameter to `add_member`; reject when the
  credential identity differs.
- Pin trust properly: the client must hold each peer's identity pubkey
  (fetched over the authenticated WS and cached locally, TOFU) and reject any
  KeyPackage whose signature key differs from the pinned key.
- Replace the `|_| true` external-commit validator with the same check.
- Validate the Welcome's sender credential in `join_from_welcome`.

**Done when:** a test in `crypto-core/tests/` simulates a hostile relay
returning a mismatched-credential KeyPackage and `add_member` returns an error;
a second test covers a substituted signature key on a matching identity.

### 0.2 Bind verification to keys, not handle strings ⛔ CRITICAL — DONE

`controller.js:2249-2254` appends the peer's *handle* to `record.verified`.
Nothing stores the key that was verified and nothing re-checks on epoch or
membership change, so the ✓ survives a key substitution — including the one in
0.1.

**Fix:** store `{handle, keyFingerprint}`. Recompute on every membership change;
if the fingerprint moved, drop to unverified and surface a distinct "this
person's key changed" state in `Members.jsx`, not a silent revert.

**Done when:** removing and re-adding a member with a new key clears the badge,
covered by a client test.

### 0.3 Bind the auth challenge; stop honoring arbitrary relays — DONE

The signed challenge is `b"relay-auth-v1" ‖ nonce` (`relay/src/server.rs:294-295`)
— bound to no origin, no username, no channel. `client/src/App.jsx:224` accepts
`?relay=` with no allowlist and `client/src/lib/invite.js:55-58` propagates it
into invite links, so a hostile relay can forward the real relay's nonce and
replay the victim's signature upstream. Currently mitigated only by the CSP the
relay itself serves — a statically-hosted build ships with no protection.

**Fix:** include relay origin, username, and a server-chosen session id in the
signed payload. Use `verify_strict` (`server.rs:351`). Allowlist `?relay=` to
same-origin unless an explicit dev flag is set. Add a `<meta>` CSP to
`client/index.html` so the protection survives static hosting.

### 0.4 Make the invite gate consume a use — DONE

`registration_allowed` (`server.rs:342`) calls `invite_usable`
(`store.rs:577-583`), which only *reads*. Only `RedeemInvite` increments. One
never-redeemed `max_uses: 1` link registers unlimited accounts on an
"invite-only" relay.

**Fix:** registration must atomically redeem in the same transaction that pins
the handle. Add handle charset/length validation while you're there — the relay
validates neither.

### 0.5 Authenticate blob writes — DONE

`PUT /blobs/{id}` (`relay/src/lib.rs:55`) has no auth and sits outside both rate
limiters, with a 25 MiB body cap and caller-chosen ids. Any stranger can fill
the data volume, which also takes Postgres down (same disk).

**Fix:** issue a short-lived, single-use upload ticket over the authenticated
WebSocket; require it on PUT. Add a per-IP byte budget and attach the rate
limiter to the blob routes. Scope `CorsLayer::permissive()` (`lib.rs:81`) to the
blob routes only — it currently blankets the account endpoints.

### 0.6 Fail closed on authorization — DONE

`senderIsAdmin` (`controller.js:1834-1840`) returns `true` when the role cache
lacks the sender, and `refreshRoles` swallows its errors (`:1855`). A fresh
joiner has no roles until an async fetch lands; in that window a non-admin's
`{k:'chan-del'}` reaches `db.msgsDelete(...)` — irreversible local deletion.

**Fix:** fail closed for all destructive operations (`chan-del`, `vchan-del`,
`chanset`, `overview`). Queue-and-retry rather than default-allow when roles are
unknown.

### 0.8 Make removal actually remove — DONE

Found while tracing what removal does, after the fork work. The MLS commit
re-keys the group, so a removed member reads no further messages — but two
other doors stayed open, and one of them was held open *by the removal
itself*.

- **The kept-history key was never rotated.** `meta.hkey` is minted when
  history is switched on (`controller.js:1096`) and dropped only when it is
  switched off; `removeMember` never touched it. A removed member therefore
  kept a valid key for that channel's *future* entries, with only the relay
  ACL — the deliberately weak boundary — in the way.
- **Removal kept the leaver's invite link alive.** `removeMember` called
  `refreshInvites`, which re-parks a fresh GroupInfo blob under the *same*
  invite id. `RedeemInvite` (`server.rs:823-835`) grants relay membership to
  whoever presents the id, with no check against who was removed — its own
  comment calls the link a bearer token. So a link the removed member still
  held kept working, and they could rejoin.

**Fixed:** removal now rotates each history-enabled channel's key (archiving
the superseded one so members can still read the past, capped at 8) and
revokes every parked invite instead of refreshing it. Both are announced in
the channel, since revoking also invalidates links held by legitimate
pending joiners and nothing can tell the two apart.

**Still open here:** there is no way to revoke a *single* invite from the UI,
and no device revocation at all (Phase 6).

### 0.7 Remaining Phase-0 items

- **Passkey wrap takeover** — `server.rs:974-988` upserts a client-chosen
  `cred_id` with `ON CONFLICT (cred_id) DO UPDATE SET user_id = $2`
  (`pg.rs:541-557`), letting an attacker lock a victim out of device recovery.
  Scope uniqueness by `(user_id, cred_id)` and reject cross-user conflicts.
- **`FetchKp` is unauthenticated and destructive** (`server.rs:480-485`) — add a
  membership/intent check and stop draining another user's KeyPackages.
- **`Welcome` does not constrain `to`** (`server.rs:720-758`) — enables
  unbounded stored-welcome writes and push spam at strangers.
- **Game iframe sandbox is defeated** — `GameStage.jsx:91-99` combines
  `allow-scripts` with `allow-same-origin` while `games.js:45-49` permits
  same-origin paths. Drop `allow-same-origin`; reject same-origin activity URLs.
- **Replayable password login** — `account.rs:203-228` has no nonce or
  timestamp. Move it to the same challenge-response the WS path already does
  correctly.
- **Rate limits keyed on full `IpAddr`** (`ratelimit.rs:18`) — a /64 defeats
  them. Key IPv6 on the /64. `client_ip` (`ratelimit.rs:58-70`) trusts the first
  XFF hop; nginx's standard `$proxy_add_x_forwarded_for` *appends*, making
  `TRUST_PROXY=1` a full bypass under a common config. Take the last hop, or
  make the trusted-proxy count explicit.

---

## Phase 1 — Correctness & data integrity

**Target: 3–4 engineer-weeks. Depends on Phase 0.**

### 1.1 Fix the unrecoverable group fork ⛔ CRITICAL — DONE

`merge_pending_commit` fires immediately (`client.rs:305,325`), before the relay
accepts the commit, and the relay never validates `epoch` — `append_message`
stores whatever the client claims (`server.rs:649-682`). Two admins acting
within the same second at epoch 5 both merge to divergent epoch 6. Each other's
messages become "undecryptable blob" forever, swallowed silently at
`controller.js:594-597`. There is no detection and no recovery path.

This is the hardest item in the plan and needs a real design, not a patch:

1. **Stage, don't merge.** Hold the pending commit; merge only on relay ack.
2. **Relay-side epoch CAS.** The relay must reject a commit whose epoch is not
   the group's current epoch. This requires distinguishing commit-bearing
   messages from application messages — a protocol change, since payloads are
   opaque today. Add an explicit `kind` discriminator to the send frame. Note
   the metadata cost honestly: the relay already sees `epoch`, so this reveals
   *which* messages are membership changes. Document it in `proto.rs` alongside
   the existing per-variant leak notes.
3. **Client resync.** On rejection: discard the staged commit, process the
   winning commit, rebuild intent, retry. Surface a transient "syncing" state.
4. **Detection for already-forked groups.** Track consecutive decrypt failures
   at a known-good epoch and offer an explicit recovery (rejoin via external
   commit) rather than silent breakage.

**Done when:** an integration test drives two clients into a simultaneous commit
at the same epoch and both converge on the same epoch with no message loss.
Every existing epoch test covers only a *stale* message — this path has zero
coverage today.

**Parts 1–3 done.** Part 4 (detection) is now done too; the recovery half of
it is described below and needs a decision.

**Detection — done, `client/src/lib/fork.js`.** The difficulty is not spotting
a decrypt failure, it is that undecryptable blobs are *normal*: our own
commits come back on catch-up, blobs arrive from epochs we have not applied
yet, and a restored read-only stub decrypts nothing at all by design. A
detector that counted those would tell every healthy user their circle is
broken, which is worse than saying nothing.

So only one shape counts: a message from somebody else, at an epoch we
believe we have already reached, that will not open — five consecutively from
the same sender. Counting is **per sender**, which is what makes it useful in
both directions. With alice and bob on one branch and carol on another, carol
sees everyone fail and learns she is the one cut off; alice sees bob succeed
between carol's failures, and a single group-wide counter would reset on bob
and tell alice nothing. Per sender, alice learns the true and different fact
that *carol* cannot be reached. The asymmetry is the right way round — the
device that is cut off detects fastest, and it is the one that must act.

Nothing is persisted: a stale "this circle is broken" flag surviving a
successful rejoin would be worse than re-earning the verdict over the next
few messages, so `boot()` drops it and live traffic re-derives it.

**Recovery — NEEDS A DECISION, and this is the reason it is not done.**
Rejoining by external commit already works (`joinByExternalCommit`, used by
the invite path). What a forked device cannot get is a *current* GroupInfo:
the only GroupInfo this client can obtain comes from an invite blob, and our
own parked invites were re-encrypted from our own broken branch. So today the
notice tells the user to get a fresh invite link from a member whose circle
still works — real recovery, but manual.

Making it automatic means the relay serving current GroupInfo to any member
on request. That is a protocol addition with a genuine cost: GroupInfo is
currently reachable only via an unguessable invite id plus a fragment key the
relay never sees, and an endpoint that hands it to any authenticated member
widens what a compromised relay account can pull. Three options:

1. **Leave it manual.** Zero new surface. The user has to ask somebody.
2. **`get_group_info` for members only**, rate-limited, returning the same
   encrypted blob shape. Convenient; widens the ACL's blast radius, and the
   ACL is explicitly advisory in this design.
3. **Let a healthy member push a recovery blob** when they see a stranded
   sender — detection already identifies exactly who is stranded. Keeps the
   relay out of it, but needs a new envelope and only works while somebody
   healthy is online.

Recommendation: (3), because detection already produces the input it needs
and it adds no relay-side capability. (1) is the honest status quo until then.

### 1.2 Make persistence atomic

`onGroupMessage` (`controller.js:546-598`) advances the ratchet, persists MLS
state (txn 1), stores the message (txn 2), then writes `lastSeq` (txn 3). A
crash between txn 1 and txn 3 leaves the ratchet advanced past a message whose
seq was never recorded; on reconnect the relay replays it, decryption fails, and
it is silently dropped.

**Fix:** one IndexedDB transaction spanning MLS state, message, and cursor. If
that is impractical, persist the cursor *last* and make replay idempotent —
accept a duplicate over a loss.

### 1.3 Narrow the error taxonomy

The same `try` in `onGroupMessage` wraps decryption *and* all downstream content
handling, so a quota error, a JSON edge case, or a bug in the reaction handler
all surface as "undecryptable blob seq N". This is why 1.2 and storage failures
are invisible today. Split the blocks and give each failure class its own log
and user-visible state.

### 1.4 Handle infrastructure failure instead of hanging

- `rpc.js:3` registers no `worker.onerror` and never rejects or times out
  pending promises — a failed WASM load hangs `boot()` forever on the splash.
- `App.jsx:234` calls `openDb().then(...)` with no `.catch`, so private-browsing
  IndexedDB rejection is an unhandled rejection and the same infinite spinner.
- There is no React error boundary (`main.jsx:6`), so any render throw is a
  white screen.
- `relay.js:129-136` `request()` has no timeout; a dropped `rid` hangs its caller
  forever.

Each needs a real failure state with a retry affordance and a diagnostic.

### 1.5 Voice correctness

- **Glare loses a track permanently.** `voice.js:1164-1165` rolls back on glare
  but never sets `renegotiateNeeded` (cleared at `:718`) and no
  `onnegotiationneeded` handler exists. Two people starting screen share
  simultaneously leaves one with a permanently blank tile. Reproduced against
  the repo's own mocks.
- **Hot hardware on send failure.** `voice.js:690` sets `this.camera` before an
  unguarded `await this.send(...)`; a rejection leaves the camera light on with
  the UI showing "start camera" and the re-click guarded to a no-op.
- **Hanging up during the screen picker** throws `Cannot destructure property
  'server' of null` (`voice.js:605`).

### 1.6 Store parity

`memory_store.rs` and `pg_store.rs` are independently written suites, which let
two divergences ship: `disallow_member` returns `NoSuchGroup` in memory
(`store.rs:317-322`) but silently succeeds in Postgres (`pg.rs:271-279`); and
`create_invite` overwrites in memory (`store.rs:538-545`) while Postgres does
`ON CONFLICT DO NOTHING` and detects a missing group by **string-matching
`"foreign key"` on the error** (`pg.rs:751-757`).

**Fix:** one generic `async fn conformance<S: Store>(s: S)` run against both
impls. Fix both divergences and replace the string match with a typed error code.

### 1.7 Protocol hygiene

Add a version field to `Hello` (`proto.rs:16-21`) — client/relay skew currently
has no handshake signal. Add a catch-up completion marker to `Subscribe` so the
client can tell when backfill is done. Validate the inner envelope: `chat.text`
is stored raw and unbounded (`controller.js:615-622`) while `react.emo` and
`reply` are clamped.

### 1.8 Lower-severity correctness

`markSeen` clock skew hides unreads from clock-behind senders
(`controller.js:1178`); `App.jsx:333-337` re-marks seen with no
`visibilityState` check. `memberVtName` (`viewTransition.js:38`) collides for
`a.b.c` vs `a-b-c`, aborting the whole transition. Edit/delete patches are lost
across a channel rename (`controller.js:678,691`).

---

## Phase 2 — Test & release engineering

**Target: 2–3 engineer-weeks. Can run parallel to Phase 1.**

Today there is **no CI test gate at all**. `.github/workflows/` contains only
`deploy.yml`, which SSHes into production on every push to `main`. 83 Rust
integration tests, ~12 in-src unit tests, and 119 client tests never run.

### 2.1 A real CI pipeline — DONE

On every PR and every push to `main`, blocking the deploy job:
`cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --workspace`,
`cargo deny check`, `npm test`, `npm run build`, and the e2e journey. Fix the
dependency leak in `test/view-transition.test.mjs` — it imports the one lib
module with a React dependency, so a clean checkout fails 1 test.

Also correct `README.md:210`: it claims 27 tests; the real count is ~95.

### 2.2 Make the risky paths testable

The architecture review identified clean seams; take the two that unblock
testing rather than the whole refactor:

- **`applyEnvelope(record, sender, content, ctx) → {record, effects}` — done.**
  Lives in `client/src/lib/envelope.js`; `Controller.runEffects` is now the
  only thing that touches the database, the voice manager or the UI.
  `controller.js` lost ~300 lines and the protocol's semantic core is
  reachable from a plain object (`test/envelope.test.mjs`, 41 tests).

  Two design points are load-bearing:

  - **Effect-free, not mutation-free.** The record is still mutated in place
    and handed back, because that is the contract every caller of `onContent`
    already relies on. A fully immutable record would double the size of the
    change for no gain in testability, which was the goal.
  - **The admin gate is resolved *before* the reducer.** `senderIsAdmin` is
    async — it can consult the relay's ACL — and an async reducer is not a
    reducer. `adminRequirement(kind)` is the allowlist, so ordinary chat
    traffic pays for no check, and a kind that needs an answer but did not get
    one **fails closed**.

  The extraction also surfaced an authorization property nobody had written
  down: `canRemoveNotice` fails *open* when the remover's role is unknown.
  That matches the advisory admin gate elsewhere, and it is now pinned by a
  test that says so rather than being an accident of the code.
- **`AccountService` — done.** `client/src/lib/account.js`: vaults, passkeys
  and the three sign-in paths. The seam is that **unlocking returns the
  identity bytes rather than adopting them** — deciding a vault opened is the
  service's job, installing an identity and booting on it stays in the
  controller, so the irreversible half is in one place and the rest is
  testable without a worker.

  `credentials`, `fetch` and `webcrypto` are injectable, which is what lets
  `test/account.test.mjs` (18 tests) drive sign-in with no browser. The one
  that matters most asserts that **neither the Argon2id wrap half nor the bare
  identity ever appears in the `vault_set` payload** — the guarantee the whole
  password-vault design rests on, and a regression there would be silent and
  total. It was mutation-tested to confirm it fails when the wrap key leaks.

### 2.3 Close the named coverage gaps

In risk order: concurrent commits at the same epoch (zero tests); glare followed
by re-offer; `senderIsAdmin` fail-open (only the closed path is tested,
`controller.test.mjs:112`); `channelDigest` (zero tests); IndexedDB quota
injection; WASM/worker load failure; reconnect resync losslessness
(`reconnect_race.rs` only proves a subscription survives socket teardown); blob
auth/DoS.

### 2.4 Safe deploys — **done**

Three separate problems, all closed.

**The health gate.** It accepted any 1xx–4xx — a 404 passed — and fetched `/`,
a static file that never touches Postgres, so a relay with a dead database
deployed clean. It now polls `/healthz` and accepts only a real 2xx.

**The host key.** `ssh-keyscan` ran on every deploy, re-TOFUing the host and
making the `StrictHostKeyChecking=yes` on the next line decorative. A pinned
`DEPLOY_KNOWN_HOSTS` secret is used when set, with a loud warning when not.

**Rollback.** This was the serious one: rollback was `git reset --hard` plus a
full Rust + wasm-pack + Node rebuild *on the production box*, so the recovery
path was itself a multi-minute build that could fail — the worst possible
property for a path you only run when something is already wrong.

The image is now built in CI and pushed to GHCR tagged by commit SHA; the
server pulls and restarts. Rollback re-points `QUORUM_IMAGE` at the
previously-running image (read from the running container, with a state file
as fallback) and restarts — seconds, no compile, nothing fetched. Tagging by
SHA rather than only `latest` is what gives the server something specific to
roll back *to*.

Build-on-server is kept as a fallback when `QUORUM_IMAGE` is unset. A registry
outage, a missing token or a hand-run deploy must not leave the operator with
no way to ship.

**What is not verified:** there is no way to exercise a real deploy from here.
The `deploy path` CI job covers what can be checked without a server —
`deploy.sh` parses and is shellcheck-clean, the three-file production overlay
set resolves, and `QUORUM_IMAGE` actually reaches the service (if compose
stopped honouring it, every deploy would silently keep using the old
build-on-server path). The first real deploy still needs watching, and the
server needs pull access to the GHCR package.

**Fix:** build the image in CI, push to a registry, deploy by digest, roll back
by re-pointing the tag (seconds). Health-check an endpoint that round-trips the
store. Pin `DEPLOY_KNOWN_HOSTS` as a secret.

### 2.5 Supply chain

`cargo-deny` and `npm audit` in CI, lockfile drift checks, a CycloneDX SBOM per
release, Docker base images pinned by digest, and Renovate for updates. For a
security product this is table stakes and currently absent.

### 2.6 Extend integrity coverage to the worker and WASM — **mostly done**

**The unoptimized-wasm trap is closed.** `build-wasm.sh` shipped an
unoptimized artifact with only a warning when wasm-opt was missing, so a
release could silently differ from every local build for a reason nobody would
think to look for — and the published hashes would then describe a binary
nobody intended. `WASM_REQUIRE_OPT=1` makes it a hard failure; CI sets it.
Locally it stays a warning, so a contributor without binaryen can still build.

**Turning it on immediately caught the thing it was written for.** CI installed
binaryen from apt, which on the runner is **version 108** — below the 116
threshold — so the optimizer had been silently skipped on every CI build the
guard was supposed to protect. Both CI and the Dockerfile now fetch a pinned
binaryen release (119) instead of apt.

The Dockerfile also now runs `build-wasm.sh` rather than calling `wasm-pack`
directly. It was building the wasm a *different way* from CI, which would have
made the published manifest describe a binary the image never contained —
a wrong hash being considerably worse than no hash.

**The worker now verifies the wasm before instantiating it.** `worker.js`
carries the SHA-384 this build shipped (stamped by
`client/scripts/inject-integrity.mjs`) and refuses to `init()` anything else —
a throw, not a console line, because running a crypto core that is not the one
this build was tested with is worse than not running at all. In dev the
placeholder is left literal and the check is skipped: the artifact changes on
every rebuild, and a dev worker that would not boot is worse than no check.

**Hashes are published.** `dist/integrity.json` lists every executable
artifact — the asset bundles, `worker.js`, `sw.js`, `index.html`, and the
crypto core — and CI prints it to the run summary and uploads it. That is what
lets someone who does not trust the deployment fetch the files, hash them, and
compare. `sw.js` is in the list even though nothing can enforce its hash at
load time: the manifest exists for third-party verification, and the service
worker is code.

**What this does NOT buy, stated plainly:** it is no defence against a hostile
operator, who serves `worker.js` and the manifest too and would change both.
What it catches is the wasm being wrong *on its own* — a partial deploy, a
stale or poisoned cache, a CDN out of step with the page.

**Reproducible builds — demonstrated, within stated limits.** The compiler is
pinned in one place (`rust-toolchain.toml`, honoured by rustup in CI, in the
Docker build and on a laptop alike), binaryen is pinned to a release rather
than taken from apt, and the `reproducible build` CI job rebuilds every commit
from a clean tree **on a different machine** from the one that published the
manifest, then diffs the two. It fails, loudly and with the diff, if they
differ.

The job is deliberately unlike the `build` job in three ways, so that a match
carries information: it sets `--remap-path-prefix` (the other does not),
installs `wasm-pack` from source rather than from a prebuilt action, and
starts with no cargo cache.

That last difference produced the most useful result. If checkout paths were
embedded in the wasm, the remapped and unremapped builds would differ — they
do not, so paths are not in the artifact at all. That is precisely the
property a third party needs in order to rebuild at their own path and match.

**What is established:** same commit + same pinned toolchain + `ubuntu-latest`
x86_64 → byte-identical artifacts across independent machines, caches and
flags.

**What is not:** a different OS, architecture, libc or container base. Nobody
has yet rebuilt this on hardware GitHub does not own, which is the only test
that fully answers §6.2. The check itself is still bounded by one runner image.

`docs/VERIFYING.md` is the procedure for a third party to do it: fetch
`/integrity.json`, hash the served files against it, then rebuild the named
commit and diff. The manifest now records its own `commit`, without which a
verifier would know the hashes but not which source to build — most of the
point. It is stamped from `SOURCE_COMMIT` rather than read from git, because
the Docker build has no `.git`, and omitted rather than guessed when absent.

**The remaining gap is social, not technical.** A mechanism nobody exercises
detects nothing. Someone outside CI has to actually run that procedure, on
hardware GitHub does not own, for the guarantee to mean anything.

---

## Phase 3 — Reliability & scale

**Target: 4–6 engineer-weeks.**

### 3.1 Remove the global send lock

`server.rs:659-682` performs a database round-trip **inside**
`app.hub.lock().await`. Every message in every group serializes behind one mutex
plus one DB write. This is the single hard ceiling on throughput.

**Fix:** allocate `seq` in the database (per-group sequence, `INSERT … RETURNING`),
take a per-group lock only for fan-out ordering, and keep the DB round-trip off
the global lock.

### 3.2 Horizontal scale

The relay is a single process: `Hub` is in-memory, rate limits are per-process
(`ratelimit.rs:5-6`), and two replicas would not fan out to each other. Add
cross-instance fan-out (Postgres `LISTEN/NOTIFY` for modest scale, Redis pub/sub
beyond it) and move rate-limit state to shared storage. Until then, publish the
real ceiling — hundreds of concurrent sockets on a small VPS — rather than
leaving it implied.

### 3.3 Backpressure — **done**

Outbound queues were unbounded; a stalled client buffered in the relay's RAM
until the 30-second ping failed. One suspended laptop in a busy circle was an
unbounded server-side allocation.

The bound is applied where it is safe rather than everywhere, because the two
users of the queue are not alike:

- **Fan-out** (`Outbound::offer`) refuses past `MAX_QUEUE` and the subscriber
  is dropped. This is *lossless*: the relay is an ordered log, so the client
  reconnects, resubscribes from its last seq, and receives everything it
  missed. That property is the entire justification for the bound.
- **Catch-up backfill and a connection's own replies** (`Outbound::send`) have
  no cap. A bounded channel here would either truncate a backlog silently —
  the client asked for it and cannot see the gap — or block on network
  backpressure while the hub lock is held, putting every other circle behind
  one slow socket and undoing §3.1.

The channel therefore stays unbounded and the *depth* is tracked explicitly,
decremented by the writer as each message leaves. `quorum_subscribers_dropped_total`
counts the cuts: they are recoverable, but to the person it happens to they
are indistinguishable from a lost message, so they must be visible.

### 3.4 Reclaim disk — history and blobs done, messages open

Nothing garbage-collected. History expiry was **lazy only**, triggered inside
`history_after`, so an abandoned channel's expired ciphertext lived forever,
quietly contradicting the auto-delete promise. Blobs were never deleted at all.

**History: done.** An hourly sweeper deletes expired entries everywhere, not
just in rooms someone still opens.

**Blobs: done, and not the way this plan originally specified.** The original
fix said "a blob GC keyed on referenced ids". *That cannot be built here.* A
blob id lives inside the encrypted message that refers to it, so the relay
genuinely does not know which blobs are still wanted; reference counting would
require reading plaintext, which is the one thing the design forbids. Age is
the only honest policy available.

So `BLOB_TTL_DAYS` deletes attachments older than N days, **off by default** —
silently deleting a user's attachments is not a behaviour anyone should
acquire by upgrading. Its cost is real and stated rather than hidden: an old
attachment can 404 while the message referring to it is still readable, so the
TTL must be set above the longest kept-history retention in use. The sweep
filters on `path_for`, i.e. only names that are valid blob ids — which is what
keeps `vapid.key` out of it. That file shares the directory and its loss
silently kills every push subscription on the deployment, so this is not a
detail: it is the failure mode the runbook opens with.

**Messages: still open, and the design constraint is the point.** The
`messages` table is the MLS log and is never pruned. Naive age-based pruning
would be **unsafe**: an application message is content, but a *commit* is the
epoch chain, and a device that has not processed a commit cannot advance to
any later epoch. Deleting one strands that device permanently.

A safe implementation therefore has to:

1. Persist the `commit` flag (currently passed to `append_message` for the
   epoch CAS but not stored), via an additive column.
2. Backfill it as `true` for pre-existing rows — conservative, because a row
   whose kind is unknown must never be deleted.
3. Prune only non-commit rows past a TTL, and never a commit under any
   circumstance.

The client side already permits this: its cursor is
`lastSeq = Math.max(lastSeq, seq)`, a high-water mark rather than a
contiguity check, so gaps in `seq` do not strand a subscriber. Left
unimplemented here rather than half-verified, because it is the one change in
this plan whose failure mode is permanent, unrecoverable data loss.

Still open alongside it: disk quotas and alerting.

### 3.7 Publish the ceiling — **done**

`docs/CAPACITY.md` records every hard limit with the constant behind it, the
structural limits that have no constant (the voice mesh, group size), and —
separately and explicitly — the list of things that have **never been
measured**. Throughput, concurrent connections and fan-out latency are in that
second list. An unmeasured number stated confidently is worse than no number,
and the latency histograms that would answer the third are still open in
Phase 4.

### 3.5 Schema versioning and upgrades — **done**

`migrate()` was idempotent and race-safe behind an advisory lock, which was
good, but there was no `schema_version` table and no down path. That was
survivable only because every change so far had been additive; the first
destructive change would have stranded operators.

`migrate` now records `SCHEMA_VERSION` and **refuses to start against a
database written by a newer relay** rather than operating on a shape it does
not understand — a rollback that half-works corrupts more than one that
refuses. Older databases are still brought forward by the same
`CREATE TABLE IF NOT EXISTS` batch. `deploy/RUNBOOK.md` gained the *Upgrading*
section, including what that refusal looks like and how to get out of it.

Still open: a genuine down path. Refusing is the correct behaviour at the
boundary, but it means a rollback past a destructive migration needs a
restore, and there are no reversal scripts to make it cheaper.

### 3.6 HA and disaster recovery

Multi-instance relay behind a load balancer (needs 3.2), Postgres replication
with PITR, and — critically — a **tested** restore. State lives in three places
and one is not where you would look: the `blobs` volume is mounted at `/data`
and also holds the auto-generated VAPID private key (`Dockerfile:39-43`). Lose
it and every existing push subscription silently dies. Rename the volume, and
run restore drills on a schedule.

---

## Phase 4 — Operability

**Target: 2–3 engineer-weeks.**

The entire relay emits six log statements. There are no metrics, no `/healthz`,
and no way to answer "why aren't my messages arriving?" — an operator has
literally nothing to look at.

- **Structured logging** (JSON, correlation ids), INFO on connect/disconnect/
  subscribe with counts. Move the one metadata-bearing line — a plaintext handle
  on push failure (`server.rs:226`) — to `debug`.
- **Metrics** (Prometheus): connections, messages/sec, per-group fan-out size,
  push success rate, DB latency, blob bytes written, error rates by class.
- **Distributed tracing** (OpenTelemetry) across the WS handler and store.
- **`/healthz` and `/readyz`** with a store round-trip and the build SHA.
- **Runbooks and alerts** for the four realistic incidents: messages not
  arriving, disk full, push delivery failing, cert expiry.
- **Config validation at boot.** `account.rs:44-48` has three `.expect()`s on
  WebAuthn config; combined with `restart: unless-stopped` a typo becomes a
  crash loop with a bare Rust panic. Validate all config at startup and fail
  with an actionable message. Document the three undocumented vars (`STUN_URLS`,
  `RUST_LOG`, `VAPID_KEY_FILE`) and add `RELAY_ADMINS`, `TRUST_PROXY`, and
  `SERVER_IP` to `.env.example`. Generate `POSTGRES_PASSWORD` instead of
  shipping the literal `quorum`.
- **Close the bootstrap race:** the first connection to an empty relay registers
  unconditionally (`server.rs:334-340`), so a scanner can claim a fresh relay
  between `up -d` and the admin's first sign-in. Add a bootstrap token.
- **Fix TURN for real deployments:** `deploy/docker-compose.turn.yml:27-45` has
  no `--external-ip` (useless relay candidates on AWS/GCP/Azure, where the VM
  sees a private address), no `turns:` listener on 443/5349 (fails on
  UDP-blocking corporate Wi-Fi), a 40-allocation port range that an 8-person
  mesh exhausts, and no quotas. Client-side, ICE servers are fetched once at
  connect (`controller.js:389`) while `TURN_TTL` defaults to 3600s — any tab
  open longer than an hour starts calls with expired credentials and silently
  degrades. Re-request before each call.
- Assert Compose ≥ 2.24 in `setup.sh` (`ports: !reset []` needs it; the current
  check only verifies that `docker compose version` runs).

---

## Phase 5 — Client quality

**Target: 4–6 engineer-weeks. Parallelizable with Phase 3–4.**

### 5.1 Accessibility (blocks most enterprise procurement)

No modal in the app is a dialog. `Modal.jsx:97`, `Settings.jsx:116`, and
`NotificationsPrompt.jsx:37` render bare `<div>`s — no `role="dialog"`, no
`aria-modal`, no initial focus, **no focus trap, no focus restore**. Tab from an
open modal walks into the app behind it. Drawers have no focus management or
`aria-expanded`.

Also: `--ink-mute` is 3.71:1 in dark and 2.85:1 in paper and carries most
metadata in the product — both fail WCAG AA. Hit targets run 19–36px against a
44px minimum. `MessageActions` renders 4 keyboard-reachable buttons per line, so
a 200-line channel is ~800 tab stops.

A VPAT / WCAG 2.2 AA conformance statement is a standard procurement gate; this
is the work required to earn one.

### 5.2 Mobile & PWA

The README claims "that's the mobile app". On iOS it is not, and the most severe
issue is silent data loss: WebKit's 7-day cap on script-writable storage evicts
the IndexedDB MLS state *and* the localStorage identity mirror.
`navigator.storage.persist()` is called once in `completeOnboarding`
(`controller.js:267`) with its return value discarded, and Safari does not
implement it. A user following the README is on an undisclosed timer to losing
their account.

The storage half is **done** — `persist()` every boot, checked, with a standing
banner when it is refused.

The **offline shell is done** too. There was no `fetch` handler at all, so an
installed PWA white-screened offline while every message it needed sat in
IndexedDB on the same device. `public/sw.js` now precaches the shell into a
cache named for a content hash of that shell, and drops every older one on
activate. Three decisions carry the correctness:

- **Navigations are network-first**, cached-shell second. `index.html` is not
  content-hashed, so cache-first would pin the app at whatever version was
  cached first — the classic way a PWA becomes unupdatable.
- **`sw.js` is never cached.** A cached service worker cannot replace itself.
- **Nothing is cached at runtime.** The list is fixed at build time and
  excludes `/blob/`: attachments are large and would compete for the same
  origin quota the message store already has to fight for on iOS.

Selection and versioning live in `client/scripts/shell-manifest.mjs`, apart
from the script that writes them, because the only place a mistake there
surfaces is a build that needs wasm-pack — the slowest feedback loop in the
repo. `client/test/sw-fetch.test.mjs` drives the worker's own handlers in a
`vm` against a stubbed Cache API. The new code-delivery surface is recorded in
`docs/THREAT_MODEL.md`.

The **update notice is done**: a deploy swaps the shell underneath a running
page (the worker calls `skipWaiting`), so the new cache takes over while the
tab is still executing the previous bundle and any chunk it loads lazily from
then on is one the new shell no longer has. `controllerchange` now raises a
notice — guarded so a *first* install, which fires the same event, is not
greeted with news of a version it just installed. It tells you to reload
rather than reloading for you: a tab that reloads itself mid-sentence is a
worse outcome than a stale one, and only the person typing can judge when it
is safe.

Still open here: an iOS Add-to-Home-Screen interstitial explaining that the install is required both
for notifications and for keys to survive; wake lock + Media Session so calls
survive screen lock; `visualViewport` handling so the composer is not covered
by the keyboard; `popstate` so the back button closes a drawer rather than
exiting the app.

### 5.3 UX gaps that block adoption

Rail unread badges are **done**. The per-channel seen markers already existed
(`markSeen`, `channelDigest`); what was missing was the roll-up, so nothing on
screen said a circle you were not looking at had moved. `circleUnreads()` now
totals them per circle and the rail renders a badge — brightening the tile as
well, since an inactive tile sits at 0.62 opacity and a badge over a dimmed
tile reads as contradiction. The counting rules moved out of `channelDigest`
into exported `countUnread`/`seenFloor` and are covered by
`client/test/unread.test.mjs`; the sharp edge is the `joinedAt` floor, without
which joining a circle counts its whole backfilled history as unread.

**Mention** badges are still open, and deliberately: there is no `@handle`
affordance in the composer, so a matcher would be half a feature.

Local message search is **done**, in the ⌘K palette rather than on a new
surface — search has to live somewhere, and a second overlay is a worse
answer than the keystroke people already press. Message hits rank below the
room and action rows (navigation is what the palette is for) and are matched
by `client/src/lib/search.js`: AND across terms, quoted phrases, attachment
filenames, newest-first, capped at 40 with the truncation reported rather
than implied.

The scan is linear over IndexedDB, deliberately. An inverted index would have
to live in the same store as the plaintext it indexes — a second copy of
every message to keep consistent and to purge on retention and on leave — and
at this scale the scan is the cheaper correctness story. The palette footer
states the real limit: **search covers this device only**, because the relay
holds ciphertext and cannot index it.

The **kept-history indicator is done**. The forward-secrecy trade was
announced once, in a system chip that scrolled out of view — so the README's
"clearly-labeled trade" was true only for whoever happened to be looking. A
room whose `chanMeta.hid` is set now carries a standing note in its header:
*history kept — new members can read back*, with the full trade in its
tooltip. It is the one item in that strip that is not grey, because it is the
one that changes what the encryption guarantees.

The **voice participant cap is done**. `MESH_LIMIT` is 8, checked *before* the
microphone is captured — refusing a call is bad, refusing it having just
turned on someone's mic is worse — and the join button says "full" rather than
letting the click fail. The refusal names the reason: calls are peer-to-peer,
so every extra person costs everyone else bandwidth. It is enforced
client-side and therefore **advisory**; media is peer-to-peer, there is no
authority to ask, and two simultaneous joins can both see room. It converts
the common case from a silent collapse into a clear refusal, which is all a
client-side check can honestly claim.

**Call-peer IP exposure is now opt-out.** The threat model listed it as OPEN:
media is peer-to-peer, so everyone in a call learns everyone else's address,
and nothing in the UI said so. Settings → *call privacy* sets
`iceTransportPolicy: 'relay'`. Three things are stated rather than glossed:
the policy is applied **even with no TURN server configured**, so calls fail
loudly instead of silently leaking what the user asked to hide; it conceals
your address and not theirs unless they enable it too; and it takes effect on
the next call. Operators should note the bandwidth consequence — see
`docs/CAPACITY.md`.

Still open here: an escape hatch on the recovery-download gate, and mention
badges (deliberately — there is no `@handle` affordance in the composer, so a
matcher would be half a feature).

`prefers-color-scheme` is **done**. The stored preference is now tri-state —
`'paper' | 'carbon' | null`, where null means follow the system — and a fresh
install starts there instead of pinning dark. Two details were load-bearing:

- The default is applied in **CSS**, not JavaScript. The CSP allows no inline
  `<script>`, so nothing JS can do runs before the first paint; a JS default
  would flash dark and then correct itself. Plain CSS cannot share one
  declaration body between `[data-theme='paper']` and a media query, so the
  palette is written twice and `client/test/theme.test.mjs` fails if the two
  copies ever drift.
- Existing installs are untouched: the old code wrote the resolved theme back
  on every mount, so anyone who has run the app already has an explicit value
  stored and keeps it. Settings gained a *use system* button, without which
  the tri-state would be one-way.

### 5.4 Documentation honesty

The project's signature is naming its own costs, and it is currently behind its
own standard in five places: WebRTC exposes every call peer's IP to every other
peer and there is no relay-only ICE mode or disclosure (`voice.js:1047`); the
identity key is a master key to all room keys via
`SHA-256("quorum-circles-backup-v1" ‖ identity)` (`history.js:45-51`); a removed
member keeps a kept-history channel's key forever; push endpoints identify the
device's OS vendor and are a second subpoena hop; and "One device per identity"
(`README.md:244`) is contradicted by shipped device linking. Each is a
one-sentence fix.

---

## Phase 6 — Enterprise product surface — DROPPED

**Decision taken: not building this.** quorum stays a privacy product for
small groups rather than chasing enterprise procurement, so the whole
conflict below is moot. Kept for the record, and because it documents
precisely which enterprise asks are impossible rather than merely unbuilt.

**Two items from the "compatible" list are NOT dropped** — they were only
here because this section collected them, and they are ordinary security
work that the product needs regardless:

- **Device revocation.** `add_passkey_wrap` has no delete
  (`server.rs:974`) and pubkeys cannot rotate (`store.rs:114`), so
  "revoke a device" currently means burning the handle.
- **Key rotation** for the identity key, for the same reason.

Both move to Phase 1.

---

### (record only — not being built)

### Compatible with E2EE — build these

- **SSO (OIDC/SAML) and SCIM provisioning.** Authentication is orthogonal to
  content encryption. The relay authenticates connections; an IdP can drive that
  without touching MLS.
- **Metadata audit log.** Joins, leaves, role changes, admin actions, device
  enrollment, invite creation/redemption. All of this is already server-visible,
  so exposing it costs no additional privacy and satisfies a real class of audit
  requirement.
- **Device management and revocation.** Currently impossible: `add_passkey_wrap`
  has no delete (`server.rs:974`) and pubkeys cannot rotate (`store.rs:114`), so
  "revoke a device" means burning the handle. Enterprise requires real
  revocation, key rotation, and session termination. Substantial work, no
  conflict with the thesis.
- **Room key rotation on member removal.** The kept-history key is minted once
  (`controller.js:1084-1089`) and never rotates, so a removed member decrypts
  *future* messages in that channel. Rotate on every removal.
- **Org-level multi-tenancy**, per-org policy (retention floors/ceilings,
  kept-history allowed or forbidden), and data residency.

### ⚠ Conflicts with E2EE — decide explicitly

| Requirement | Status | Honest option |
|---|---|---|
| eDiscovery / legal hold | Impossible server-side | Client-side archival to a customer-controlled endpoint, or decline |
| DLP content scanning | Impossible server-side | Client-side scanning before seal, with the limits stated |
| Content moderation | Impossible server-side | User reports + message franking (in BUILD_PLAN §2, never implemented) |
| Admin reads messages | Voids the guarantee | A visible "compliance member" added to the MLS group — honest, but it changes what the product is and needs explicit consent UI |
| GDPR right to erasure | Partial | Metadata is deletable; content on member devices is not. Document precisely |

My recommendation: implement the compatible list, decline admin content access
outright, and offer client-side archival for customers who need retention. The
"compliance member" pattern is defensible *only* if every member sees it in the
roster — a silent version would be the single worst thing this project could do.

---

## Phase 7 — Assurance (in-repo preparation)

**Decision taken: prepare the materials here; the owner commissions the
external work.** Everything below that needs an outside party is marked as
such — it is not something this plan can discharge.

- **Written threat model in-repo** (STRIDE per component), reviewed each release.
  The BUILD_PLAN sections are good prose but not a maintained artifact.
- **Independent cryptographic review** of `crypto-core` and the protocol, then a
  full penetration test. Non-negotiable for a security product; schedule after
  Phase 1 so the findings are about design, not known bugs.
- **Fuzzing** (`cargo-fuzz`) on `proto` parsing and KeyPackage/Welcome/commit
  deserialization. **Blocked on a decision, not on work.** `cargo-fuzz` needs
  a nightly compiler for `-Z sanitizer=address`, and this repo now pins
  `1.94.0` in `rust-toolchain.toml` precisely so that every build uses one
  compiler — that pin is what makes the reproducible-build check (§2.6) mean
  anything. Three ways out, in order of preference:
  1. A separate `fuzz/` workspace with its own `rust-toolchain.toml` on
     nightly, run in a non-blocking scheduled CI job. Keeps the release pin
     intact; costs a second toolchain to keep alive.
  2. `afl.rs` or `honggfuzz`, which run on stable. Weaker coverage guidance
     than libFuzzer, and neither is as well maintained.
  3. Structured property tests (`arbitrary` + `proptest`) on the same parsers
     on stable. Not fuzzing — no coverage feedback, no corpus — but it does
     run in the existing gate on every commit.

  Recommendation: (1). Do not unpin the toolchain for it; a floating compiler
  would trade a verifiable release property for a testing convenience.
- **Model the epoch state machine** — DONE, `relay/tests/epoch_model.rs`.
  A seeded simulation of the §1.1 protocol: four clients, each holding the
  state a real one holds (merged epoch, log cursor, staged-but-unacked
  commit), with a PRNG choosing who acts next. Invariants are asserted after
  every step, over 64 seeds × 200 steps.

  The load-bearing one is *no client's merged epoch ever runs ahead of what
  the relay accepted* — that is the fork, stated as an assertion. Alongside
  it: one winner per epoch, accepted commits form a gapless chain from 1,
  refused commits leave nothing in the log, the log a client replays has no
  holes, and an application message may carry a stale epoch but never a
  future one.

  Two things the sweep cannot do, each with its own test. It cannot prove the
  CAS is *atomic*, because a sequential interleaving never races — so 32
  tokio tasks commit at one epoch on a multi-thread runtime and exactly one
  wins. And a random sweep does not read as the §1.1 acceptance criterion —
  so that scenario is also written out literally, two admins committing at
  one epoch and converging with no message loss.

  Why a sequential model is faithful: the relay appends under a per-group
  send lock, so every real execution *is* some serial order of these steps.
  The sweep asserts it actually raced (it fails if the run produced no epoch
  conflicts) and that a seed replays identically, so a CI failure is
  reproducible from the seed in its message rather than being a lottery.
- **`SECURITY.md`**, coordinated disclosure policy, and a bug bounty.
- **SOC 2 Type II readiness** if pursuing enterprise sales — largely a function
  of Phases 2–4 producing evidence (change management, access control,
  monitoring, incident response).

---

## Sequencing and effort

```
Phase 0 (critical security)  ██                          weeks 1-2   BLOCKING
Phase 1 (correctness)          ████                      weeks 2-6
Phase 2 (test/release)         ████                      weeks 2-5   parallel
Phase 3 (reliability/scale)        ██████                weeks 6-12
Phase 4 (operability)              ███                   weeks 6-9   parallel
Phase 5 (client quality)           ██████                weeks 6-12  parallel
Phase 7 (external audit)                 ████            weeks 12-20
Phase 6 (enterprise surface)             ??              product-gated
```

Roughly **2–3 engineers, 5–7 months** to the end of Phase 5, plus external audit
time. Phase 6 is unbounded until the product decisions in it are made.

## The three decisions I cannot make for you

1. **Does "enterprise" here mean engineering quality, or enterprise product
   features?** Phases 0–5 serve the first. Phase 6 serves the second and
   contains items that would void the encryption guarantee.
2. **Web delivery, or a packaged client?** No amount of CSP and SRI changes the
   fact that the operator serves the code and can target one user invisibly.
   Signal's model differs categorically. Reproducible builds narrow the gap;
   only a signed native client closes it.
3. **Is kept history a default, a per-channel option, or removed?** It is the
   feature most in tension with the product's thesis, and the source of two
   findings in this plan. Non-technical users will not reason about its
   consequences.

## Immediate next four changes

If only one week is available, do these — they close both critical findings and
the worst fail-open:

1. Bind the KeyPackage credential to the requested handle and the pinned key;
   drop `|_| true` (§0.1).
2. Store the key alongside the handle in `record.verified` (§0.2).
3. Stage commits until relay ack; reject stale-epoch commits relay-side (§1.1).
4. Make `senderIsAdmin` fail closed for destructive operations (§0.6).

Then add the CI workflow (§2.1), so the 95 tests that already exist actually run
before a deploy can fire.
