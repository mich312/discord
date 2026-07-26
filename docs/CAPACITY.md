# Capacity and limits

What this relay is actually bounded by, and — just as importantly — what has
never been measured.

Plan §3 asked for the ceiling to be *published* rather than discovered by an
operator at 2am. Everything in the first table is a constant you can read in
the source. Everything in the second is a guess, labelled as one. Nothing here
is a benchmark result, because no benchmark has been run.

---

## Hard limits, from the source

| Limit | Value | Where | What happens at the limit |
|---|---|---|---|
| Attachment size | 25 MiB | `blobs.rs` `MAX_BLOB_BYTES` | Upload refused (client checks too). The HTTP body limit is this + 1 KiB |
| Outbound queue per connection | 512 messages | `server.rs` `MAX_QUEUE` | Subscriber is dropped and reconnects, catching up from the log. Counted by `quorum_subscribers_dropped_total` |
| Outstanding upload tickets | 10 000 | `blobs.rs` `MAX_OUTSTANDING_TICKETS` | Further tickets mint but are not stored, so those uploads fail. Tickets also expire after 5 minutes |
| Account endpoints | 10/min per client | `server.rs` `Limits` | 429. Covers password login and passkey challenge/login |
| Sign-in params probe | 30/min per client | `server.rs` `Limits` | 429. This is the username-enumeration surface |
| New WebSocket connections | 60/min per client | `server.rs` `Limits` | 429 before the handshake runs |

Rate limits are token buckets: the per-minute figure is both the refill rate
and the burst. "Per client" means the socket peer, or the last
`X-Forwarded-For` hop when `TRUST_PROXY=1` — and for IPv6 the bucket is keyed
on the /64, not the address, so one allocation cannot mint fresh quota.

## Structural limits, no constant behind them

| Limit | Where it bites | Status |
|---|---|---|
| Voice participants | 8 (`MESH_LIMIT`) | **Enforced client-side, advisory.** Calls are a full mesh: every browser holds a connection to every other, so cost grows with the square of the party, and each video track makes it worse. The join is refused before the mic is captured and the button reads "full". Media is peer-to-peer with no authority to ask, so two simultaneous joins can both see room — this turns the common case from a silent collapse into a clear refusal, not a guarantee |
| Members per circle | unknown | MLS tree operations grow with group size, and every membership change is a commit fanned out to everyone. Untested past small groups |
| Circles per relay | unbounded | Per-group send locks mean circles do not contend with each other; Postgres connection count is the real ceiling |
| Message log growth | unbounded | Nothing prunes `messages`. See §3.4 of the hardening plan for why naive pruning is unsafe |
| Attachment storage | unbounded by default | `BLOB_TTL_DAYS` bounds it if you set it |
| TURN bandwidth | unbounded | Every participant who enables *hide my IP* relays their media through your TURN server rather than sending it peer-to-peer. Budget for it before advertising the option |

## What has never been measured

Stated plainly, because an unmeasured number presented confidently is worse
than no number:

- **Messages per second**, per circle or in total. The per-group send lock
  plus one Postgres round trip per append is the shape of the bound, but the
  actual figure is unknown.
- **Concurrent connections** before the process degrades.
- **Fan-out latency** under load. There are no latency histograms yet
  (Phase 4), so even a running deployment cannot answer this.
- **Members per circle** before commits become slow.
- **Restart recovery time** with a large log.

An operator planning for more than a few dozen active people should measure
first. Nothing here is validated at that scale.

## The one limit that is not about scale

A relay's disk fills, and a full disk takes Postgres down with it — which
presents as "the relay is broken", not as "the disk is full". Alert at 75%.
`deploy/RUNBOOK.md` covers the recovery.
