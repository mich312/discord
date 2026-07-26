# quorum — Hardening & Production-Readiness Plan

Status: proposed. Written against `266d974`.

**Progress.** Phase 0 is complete apart from one item (the replayable
`password_login`, which needs the same challenge-response the WS path
already does). §1.1 and the §2.1 CI gate are also done. All of it is green
in CI.

Done: §0.1 KeyPackage identity binding · §0.2 key-bound verification ·
§0.3 auth-challenge binding + `?relay=` allowlist · §0.4 invite gate
consuming a use · §0.5 blob upload tickets · §0.6 fail-closed
authorization · §0.8 removal hardening ·
§1.1 staged commits + relay epoch CAS · §2.1 the CI gate.
§0.7: game-iframe origin isolation, CORS scoping, IPv6 /64 rate-limit
bucketing, the X-Forwarded-For hop fix, passkey-wrap cross-user takeover,
`FetchKp` KeyPackage drain, and `Welcome` targeting arbitrary handles.

Open, in the order I would take them:
1. §0.7 remainder — `password_login` is a replayable bearer credential
   (`account.rs:203-228`): no nonce, no timestamp. Capture one request body
   and replay it forever to retrieve `wrapped`.

   **This one needs a decision, not just an implementation.** Adding a
   server nonce does NOT fix it. The client sends `auth_key`; the server
   stores only `verifier = SHA256(auth_key)`. A nonce-bound proof would
   have to be something like `SHA256(auth_key ‖ nonce)`, which the server
   cannot check without holding `auth_key` itself. So the options are:

   a. **Store `auth_key` rather than its hash**, and verify a nonce-bound
      proof. Kills replay. Costs little against a database attacker — they
      already hold `wrapped`, and the vault's confidentiality rests on the
      *wrap* half, which never reaches the server. But it does mean the
      server holds a value that grants retrieval, which the current design
      deliberately avoids.
   b. **Adopt a real PAKE (OPAQUE or SRP).** The correct answer, and the
      only one that gives mutual authentication and no server-side
      retrieval secret. Substantially more work and a new dependency.
   c. **Accept it and scope it honestly.** The exposure is retrieving
      `wrapped`, which is still Argon2id-sealed under the wrap half, so a
      replay yields ciphertext rather than an account. Rate limiting
      already applies. Document it in the README's limitations list.

   My recommendation is (c) now and (b) when the account system is next
   touched — (a) trades a documented property for a modest gain.
2. Device revocation and identity key rotation (moved here from the
   dropped Phase 6). There is currently no way to revoke a device short of
   burning the handle.
3. Recovery for groups that forked *before* §1.1 landed.
4. Phase 2 remainder: §2.2 (extract `applyEnvelope` as a pure reducer and
   `AccountService`, so the protocol core becomes testable without a relay
   and a worker), §2.3 coverage for the named risky paths, §2.4's image-based
   deploy with second-scale rollback, §2.6 reproducible builds and an
   integrity manifest covering the worker and wasm.
5. Phase 3 at the agreed single-relay scope: remove the DB round-trip from
   inside the global hub mutex, bound the outbound queues, add the GC that
   currently does not exist (blobs are never deleted; history expiry is
   lazy), add schema versioning, and publish the real ceiling.
6. Phase 4 observability — the relay emits six log statements and has no
   metrics; this is the largest single remaining chunk.
7. Phase 5 client quality — accessibility (no modal is a dialog), the iOS
   7-day storage eviction, the PWA offline shell.
8. Phase 7's remaining in-repo preparation: the STRIDE threat model,
   cargo-fuzz targets on protocol parsing, and an epoch state-machine
   simulation harness.

**Also done:** §2.5 supply-chain gate (cargo-deny + npm audit + lockfile
sync), a real `/healthz` that round-trips the store with the deploy gate
now requiring 2xx from it, pinned deploy host keys, and `SECURITY.md`.

**Phase 1 §1.1–§1.8 are done:** §1.1 staged commits + epoch CAS · §1.2
receive-path write ordering (ratchet last, closing the message-loss
window) · §1.3 decrypt and apply split into separate catches · §1.4
worker/IndexedDB failure surfaces instead of hanging on the splash ·
§1.5 glare re-offer · §1.6 store impls aligned, SQLSTATE instead of
string-matching · §1.7 request timeout + protocol version · §1.8 unread
clock skew and view-transition collisions.

**Decisions taken** (these were the open forks; the plan below is now
scoped to them):

- **Phase 6 is dropped.** quorum stays a privacy product for small groups.
  No SSO/SCIM, no compliance surface, no escrow member. The effort goes to
  Phases 3–5 instead. Note this also drops the *compatible* items that were
  parked there — device revocation and key rotation. Those are real gaps
  (there is currently no way to revoke a device short of burning the
  handle), so they move into Phase 1 rather than disappearing.
- **Phase 3 targets a single relay with a documented ceiling.** Remove the
  global send lock, add backpressure and GC, add schema versioning, and
  publish the real capacity (~hundreds of concurrent sockets on a small
  VPS). No multi-instance fan-out, no HA — the stated product is
  self-hosted clubs, and that shape fits it.
- **Phase 7 is in-repo preparation only.** Threat model, SECURITY.md and
  disclosure policy, cargo-fuzz targets on protocol parsing, and an epoch
  state-machine simulation harness. Commissioning the independent
  cryptographic review and penetration test is the owner's to do — it needs
  a human and a budget, and the findings are worth most against a settled
  codebase.

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

- **Extract `applyEnvelope(record, sender, content) → {record, effects}`** as a
  pure function from `controller.js:602-955`. This is the protocol's semantic
  core and is currently untestable without a relay and a worker. Highest-value
  refactor in the codebase.
- **Extract `AccountService`** (`controller.js:1966-2207`) — vaults, passkeys,
  sign-in, device linking, ~250 lines with almost no coupling to the rest.

### 2.3 Close the named coverage gaps

In risk order: concurrent commits at the same epoch (zero tests); glare followed
by re-offer; `senderIsAdmin` fail-open (only the closed path is tested,
`controller.test.mjs:112`); `channelDigest` (zero tests); IndexedDB quota
injection; WASM/worker load failure; reconnect resync losslessness
(`reconnect_race.rs` only proves a subscription survives socket teardown); blob
auth/DoS.

### 2.4 Safe deploys

`ci/deploy.sh:32` treats any 1xx–4xx as healthy — a 404 passes — and only
fetches `/`, a static file that never touches Postgres. Rollback is
`git reset --hard` plus a full Rust/WASM/node rebuild *on the production box*
(`:53-54`), so the rollback path is itself a multi-minute build that can fail.
`ssh-keyscan` on every run (`deploy.yml:35`) re-TOFUs the host key, defeating
the `StrictHostKeyChecking=yes` on the next line.

**Fix:** build the image in CI, push to a registry, deploy by digest, roll back
by re-pointing the tag (seconds). Health-check an endpoint that round-trips the
store. Pin `DEPLOY_KNOWN_HOSTS` as a secret.

### 2.5 Supply chain

`cargo-deny` and `npm audit` in CI, lockfile drift checks, a CycloneDX SBOM per
release, Docker base images pinned by digest, and Renovate for updates. For a
security product this is table stakes and currently absent.

### 2.6 Extend integrity coverage to the worker and WASM

`scripts/inject-sri.mjs` stamps SRI onto `index.html`'s `/assets/` tags and
honestly documents that `worker.js`, `sw.js`, and the WASM have no tag to carry
it. Close the gap with an integrity manifest the worker checks before
instantiating, plus reproducible builds and published hashes — the only real
answer to operator-served code. Note `build-wasm.sh:12-18` silently ships an
unoptimized artifact when wasm-opt is missing; make that a hard failure in CI.

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

### 3.3 Backpressure

Outbound queues are unbounded (`server.rs:357`); a stalled client buffers in RAM
until the 30-second ping fails. Bound the channels and disconnect slow consumers
with a metric.

### 3.4 Reclaim disk

Nothing garbage-collects. `messages` rows are deleted only when a whole group is
deleted (`pg.rs:288-294`). Blobs are never deleted — `BlobStore` has no `delete`
(`blobs.rs:30-48`). History expiry is **lazy only**, triggered inside
`history_after` (`store.rs:413`, `pg.rs:443`), so an abandoned channel's expired
ciphertext lives forever, quietly contradicting the auto-delete promise.

**Fix:** a periodic sweeper for expired history, a message retention policy, a
blob GC keyed on referenced ids, plus disk quotas and alerting.

### 3.5 Schema versioning and upgrades

`migrate()` (`pg.rs:28-155`) is idempotent and race-safe behind an advisory
lock, which is good, but there is no `schema_version` table and no down path.
That is survivable only because every change so far has been additive; the first
destructive change strands operators. Add versioning now, while it is cheap, and
write the upgrade runbook that currently does not exist anywhere in the repo.

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

Required: call `persist()` every boot and check the result; a standing banner
when not persisted; an iOS Add-to-Home-Screen interstitial explaining that the
install is required both for notifications and for keys to survive; SW precache
with versioned caches and an update prompt (there is no `fetch` handler at all
today, so an installed PWA white-screens offline despite every message being
local); wake lock + Media Session so calls survive screen lock; `visualViewport`
handling so the composer is not covered by the keyboard; `popstate` so the back
button closes a drawer rather than exiting the app.

### 5.3 UX gaps that block adoption

Rail unread/mention badges — without a cross-circle activity signal the
multi-circle model is unusable past two circles. Local message search (there is
none, and no copy explains why). A persistent kept-history indicator in the room
(the forward-secrecy trade is announced once in a chip that scrolls away, which
falsifies the README's central UX claim). A voice participant cap with a clear
message instead of a silent mesh meltdown past ~8. `prefers-color-scheme`
support. An escape hatch on the recovery-download gate.

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
  deserialization.
- **Model the epoch state machine** — the concurrent-commit fork (1.1) is the
  kind of bug an exhaustive simulation harness finds and unit tests do not.
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
