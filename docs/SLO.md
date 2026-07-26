# Service level objectives

What "working" means for a quorum relay, in numbers an operator can check.

Phase 4 gave the relay metrics and alerts. Alerts answer "is something broken
right now?"; they cannot answer "is this relay good enough?", and without that
second answer there is no way to decide whether an incident mattered or whether
it is time to stop adding features and fix reliability. That is what these are
for.

Rules live in `deploy/slo-rules.yml`. Load them alongside `deploy/alerts.yml`.

---

## The targets

| # | Objective | Target | Window |
|---|---|---|---|
| 1 | **Availability** — the relay answers scrapes | 99.5% | 30 days |
| 2 | **Message acceptance** — a send is not refused for a server-side reason | 99.9% | 30 days |
| 3 | **Append latency** — an accepted send completes in under 1s | 99% | 30 days |

99.5% is **3h 39m of unavailability per 30 days**. That is deliberately not
99.9%. The reference deployment is one VM running `docker compose` with
`restart: unless-stopped`, a single Postgres, and no redundancy of any kind —
a kernel upgrade and a reboot spends a chunk of the budget on its own. Writing
99.9% here would produce a number nobody could hold, and an objective nobody
believes is worse than no objective. Raising it is a deployment change (a
second instance, a managed database), not a code change.

---

## What each one actually measures

### 1. Availability

```promql
avg_over_time(up{job="quorum"}[30d])
```

`up` is Prometheus's own per-target metric, so this keeps working when the
relay is too dead to serve `/metrics` — which is exactly the outage worth
counting. It measures *scrapeability from the monitoring host*, which is a
proxy for "a user can connect", not the same thing: a relay that is up but
unreachable from the internet scores 1.0 here. Closing that needs a prober
outside the deployment, which the reference deployment does not have.
Stated rather than papered over.

### 2. Message acceptance

```promql
sum(rate(quorum_send_rejections_total{reason="backend"}[w]))
  /
( sum(rate(quorum_messages_appended_total[w]))
+ sum(rate(quorum_send_rejections_total[w])) )
```

Only `reason="backend"` counts against the budget. The other four rejection
reasons are the relay working correctly:

- `not_a_member`, `unknown_group` — authorization refusing something it should.
- `malformed` — a broken or hostile client sending undecodable base64.
- `epoch_conflict` — **the fork protection doing its job.** This one matters
  most, because it is the tempting mistake: counting epoch conflicts as errors
  would make the SLO get *worse* the better §1.1's compare-and-swap works, and
  would push whoever owns the number toward weakening the check that stops
  circles forking irrecoverably. A conflict is a correct refusal, and the
  client retries after resyncing.

So the numerator is the class where the relay itself failed — the store
returned an error and the user's message did not land.

### 3. Append latency

```promql
1 - ( sum(rate(quorum_append_duration_seconds_bucket{le="1"}[w]))
      / sum(rate(quorum_append_duration_seconds_count[w])) )
```

A bucket ratio, not `histogram_quantile`. Quantile estimates are interpolated
between bucket edges and are not aggregable across instances; the fraction of
requests inside a bucket boundary is exact and composes correctly. Since
`le="1"` is a real boundary in this histogram, the 1s threshold costs nothing
in accuracy. `deploy/alerts.yml` still carries a p95 alert — that is for
eyeballing a trend, this is for the budget.

The timer starts **before** the per-group send lock is awaited, so queueing
behind a busy circle counts. That is intentional: the sender waits either way.

---

## Error budgets and burn rate

An objective without a budget is a wish. The budget is the allowed failure:
0.5% of 30 days for availability, 0.1% of sends for acceptance, 1% of appends
for latency.

`slo-rules.yml` alerts on **burn rate** — how fast the budget is being spent —
rather than on the raw ratio, using the multi-window scheme from the Google SRE
workbook. Each alert requires a long window (does this matter?) and a short one
(is it still happening?) simultaneously, which is what stops a five-minute blip
paging someone and stops a resolved incident alerting for hours afterwards.

| Burn rate | Budget gone in | Windows | Severity |
|---|---|---|---|
| 14.4× | ~2 days | 1h and 5m | page |
| 6× | ~5 days | 6h and 30m | page |
| 3× | 10 days | 1d and 2h | ticket |
| 1× | 30 days | 3d and 6h | ticket |

**Idle relays do not burn budget.** With no traffic the denominators are zero,
the ratio is `0/0`, and the series simply does not exist — so the alert cannot
fire. That is correct rather than a gap: a relay nobody is using is not failing
anybody. It does mean SLOs 2 and 3 say nothing about a relay that is up but
that no one can reach; SLO 1 and `QuorumRelayDown` are what cover that.

---

## Reviewing these

Look at all three monthly, and after any incident.

- **Budget consistently untouched?** The target is too loose, or the thing
  being measured is not what breaks. Tighten it or replace it.
- **Budget consistently exhausted?** Stop shipping features and fix
  reliability, or admit the target is not achievable on this deployment shape
  and change the number *deliberately*, in a commit, with the reason.

The failure mode to avoid is quietly tolerating a number nobody meets. An
objective that is routinely missed and never discussed has stopped being an
objective.

## What is deliberately not an SLO

- **Throughput.** `docs/CAPACITY.md` is explicit that it has never been
  measured. An objective with an invented number would be worse than none.
- **Push delivery.** Best-effort by design, and it depends on third-party
  push services this relay does not control. Alerted on, not budgeted.
- **Voice quality.** Media is peer-to-peer; the relay is not on the path and
  cannot measure it.
