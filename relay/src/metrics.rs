//! Prometheus metrics, hand-rolled.
//!
//! No `prometheus` crate: the exposition format is a dozen lines of text and
//! the counters are atomics, so the dependency would cost more in supply
//! chain than it saves in code. Everything here is `Relaxed` — these are
//! counters read by a scraper, not synchronisation.
//!
//! **The endpoint is off unless `METRICS_TOKEN` is set.** Metrics are pure
//! metadata — how many people are online, how many circles exist, how fast
//! they are talking — and metadata is precisely what this design already
//! concedes to the operator and to nobody else. Serving it unauthenticated
//! would hand the one thing the relay does know to anyone who asks.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[derive(Default, Debug)]
pub struct Counter(AtomicU64);

impl Counter {
    pub fn inc(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add(&self, n: u64) {
        self.0.fetch_add(n, Ordering::Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// Why a client failed to get onto the socket. Split out because "auth
/// failures are up" and "auth failures are up *and they are all unknown
/// handles*" are different incidents — the second is someone enumerating.
#[derive(Default, Debug)]
pub struct AuthFailures {
    /// Signature did not verify against the pinned key.
    pub bad_signature: Counter,
    /// No such handle, and registration was not open to them.
    pub unregistered: Counter,
    /// Handle already pinned to a different key.
    pub credential_taken: Counter,
    /// Turned away by the rate limiter before any check ran.
    pub rate_limited: Counter,
    /// Malformed or unexpected handshake.
    pub malformed: Counter,
}

/// Why an append was refused. `epoch_conflict` is the interesting one: it is
/// the concurrent-commit guard doing its job, and a sustained rate of it
/// means clients are fighting rather than that anything is broken.
#[derive(Default, Debug)]
pub struct SendRejections {
    pub epoch_conflict: Counter,
    pub not_a_member: Counter,
    pub unknown_group: Counter,
    /// Payload that was not decodable base64 — a broken or hostile client.
    pub malformed: Counter,
    pub backend: Counter,
}

/// Upper bounds, in milliseconds. Chosen around what this path actually does
/// — a single indexed insert behind a per-group lock — so the interesting
/// region (1–100ms) has resolution and the tail is still visible.
const LATENCY_BUCKETS_MS: [u64; 11] =
    [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

/// A fixed-bucket histogram.
///
/// Prometheus wants *cumulative* buckets, but counting cumulatively on every
/// observation would mean touching every bucket per sample. So each
/// observation increments exactly one bucket and `render` accumulates — the
/// cost lands on the scrape, which happens once every fifteen seconds rather
/// than once per message.
#[derive(Default, Debug)]
pub struct Histogram {
    /// One per bucket, plus a final slot for everything past the last bound.
    buckets: [AtomicU64; LATENCY_BUCKETS_MS.len() + 1],
    sum_ms: AtomicU64,
    count: AtomicU64,
}

impl Histogram {
    pub fn observe_ms(&self, ms: u64) {
        let idx = LATENCY_BUCKETS_MS
            .iter()
            .position(|&b| ms <= b)
            .unwrap_or(LATENCY_BUCKETS_MS.len());
        self.buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.sum_ms.fetch_add(ms, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    fn render(&self, out: &mut String, name: &str, help: &str) {
        out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} histogram\n"));
        let mut running = 0u64;
        for (i, bound) in LATENCY_BUCKETS_MS.iter().enumerate() {
            running += self.buckets[i].load(Ordering::Relaxed);
            // Seconds, not milliseconds: Prometheus convention is base units,
            // and every dashboard and alert expression assumes it.
            let le = *bound as f64 / 1000.0;
            out.push_str(&format!("{name}_bucket{{le=\"{le}\"}} {running}\n"));
        }
        running += self.buckets[LATENCY_BUCKETS_MS.len()].load(Ordering::Relaxed);
        // +Inf must equal _count, or the series is malformed.
        out.push_str(&format!("{name}_bucket{{le=\"+Inf\"}} {running}\n"));
        let sum = self.sum_ms.load(Ordering::Relaxed) as f64 / 1000.0;
        out.push_str(&format!("{name}_sum {sum}\n"));
        out.push_str(&format!("{name}_count {}\n", self.count.load(Ordering::Relaxed)));
    }
}

#[derive(Debug)]
pub struct Metrics {
    pub started: Instant,
    pub ws_connections: Counter,
    pub auth_failures: AuthFailures,
    pub registrations: Counter,
    pub messages_appended: Counter,
    pub send_rejections: SendRejections,
    /// Welcomes handed straight to a connected device, versus parked for a
    /// device that was not online. A queue that only grows is a real signal.
    pub welcomes_delivered: Counter,
    pub welcomes_queued: Counter,
    pub push_sent: Counter,
    pub push_failed: Counter,
    pub blobs_uploaded: Counter,
    pub blob_bytes: Counter,
    /// Rejected blob PUTs — no ticket, or a ticket for a different id.
    pub blob_tickets_refused: Counter,
    /// Expired kept-history rows removed by the hourly sweep. Zero forever
    /// means the sweep is not running.
    pub history_swept: Counter,
    /// Attachments deleted by the blob sweep. Only moves when BLOB_TTL_DAYS
    /// is set.
    pub blobs_swept: Counter,
    /// How long an accepted append takes: the Postgres round trip plus any
    /// wait for this group's send lock. The one number that answers "is the
    /// relay slow, or is it the network?" — and the reason §3.1 replaced the
    /// global hub mutex with per-group locks.
    pub append_latency: Histogram,
    /// Subscribers cut loose for falling too far behind their outbound
    /// queue. Lossless — they reconnect and catch up from the log — but it
    /// looks to the user exactly like a lost message, so it must be visible.
    pub subscribers_dropped: Counter,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            ws_connections: Counter::default(),
            auth_failures: AuthFailures::default(),
            registrations: Counter::default(),
            messages_appended: Counter::default(),
            send_rejections: SendRejections::default(),
            welcomes_delivered: Counter::default(),
            welcomes_queued: Counter::default(),
            push_sent: Counter::default(),
            push_failed: Counter::default(),
            blobs_uploaded: Counter::default(),
            blob_bytes: Counter::default(),
            blob_tickets_refused: Counter::default(),
            history_swept: Counter::default(),
            blobs_swept: Counter::default(),
            append_latency: Histogram::default(),
            subscribers_dropped: Counter::default(),
        }
    }
}

/// Live values that are cheaper to read than to track. Passed in at scrape
/// time so nothing has to be kept in step with the hub.
#[derive(Debug, Clone, Copy, Default)]
pub struct Snapshot {
    pub clients_online: u64,
    pub groups_subscribed: u64,
}

fn counter(out: &mut String, name: &str, help: &str, value: u64) {
    out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n{name} {value}\n"));
}

fn gauge(out: &mut String, name: &str, help: &str, value: u64) {
    out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} gauge\n{name} {value}\n"));
}

/// One metric family with a label, emitted as a single HELP/TYPE block —
/// repeating them per label is a scrape error in strict parsers.
fn labelled(out: &mut String, name: &str, help: &str, label: &str, values: &[(&str, u64)]) {
    out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n"));
    for (key, value) in values {
        out.push_str(&format!("{name}{{{label}=\"{key}\"}} {value}\n"));
    }
}

impl Metrics {
    /// Bucket a failed append by its cause, so the send path has one place
    /// to call rather than a match at every early return.
    pub fn note_send_rejection(&self, e: &crate::store::StoreError) {
        use crate::store::StoreError as E;
        match e {
            E::EpochConflict => self.send_rejections.epoch_conflict.inc(),
            E::NoSuchGroup => self.send_rejections.unknown_group.inc(),
            // Everything else that reaches an append is the storage layer
            // failing, not the client being wrong.
            _ => self.send_rejections.backend.inc(),
        }
    }

    /// Prometheus text exposition, format 0.0.4.
    pub fn render(&self, snap: Snapshot) -> String {
        let mut out = String::with_capacity(2048);

        gauge(&mut out, "quorum_up", "Always 1; presence of the scrape target.", 1);
        gauge(
            &mut out,
            "quorum_uptime_seconds",
            "Seconds since this relay process started.",
            self.started.elapsed().as_secs(),
        );
        gauge(
            &mut out,
            "quorum_clients_online",
            "Devices currently holding an authenticated WebSocket.",
            snap.clients_online,
        );
        gauge(
            &mut out,
            "quorum_groups_subscribed",
            "Circles with at least one subscriber right now.",
            snap.groups_subscribed,
        );

        counter(
            &mut out,
            "quorum_ws_connections_total",
            "WebSocket connections that completed the auth handshake.",
            self.ws_connections.get(),
        );
        labelled(
            &mut out,
            "quorum_ws_auth_failures_total",
            "Handshakes refused, by reason. A spike in 'unregistered' alone is enumeration.",
            "reason",
            &[
                ("bad_signature", self.auth_failures.bad_signature.get()),
                ("unregistered", self.auth_failures.unregistered.get()),
                ("credential_taken", self.auth_failures.credential_taken.get()),
                ("rate_limited", self.auth_failures.rate_limited.get()),
                ("malformed", self.auth_failures.malformed.get()),
            ],
        );
        counter(
            &mut out,
            "quorum_registrations_total",
            "New handles pinned to a key.",
            self.registrations.get(),
        );

        counter(
            &mut out,
            "quorum_messages_appended_total",
            "Ciphertext blobs appended to the ordered log.",
            self.messages_appended.get(),
        );
        labelled(
            &mut out,
            "quorum_send_rejections_total",
            "Appends refused, by reason. Sustained 'epoch_conflict' means clients are \
             racing commits, not that the relay is broken.",
            "reason",
            &[
                ("epoch_conflict", self.send_rejections.epoch_conflict.get()),
                ("not_a_member", self.send_rejections.not_a_member.get()),
                ("unknown_group", self.send_rejections.unknown_group.get()),
                ("malformed", self.send_rejections.malformed.get()),
                ("backend", self.send_rejections.backend.get()),
            ],
        );

        labelled(
            &mut out,
            "quorum_welcomes_total",
            "Group invitations, by whether the recipient was online. A queue that only \
             grows means devices are not coming back.",
            "disposition",
            &[
                ("delivered", self.welcomes_delivered.get()),
                ("queued", self.welcomes_queued.get()),
            ],
        );

        labelled(
            &mut out,
            "quorum_push_total",
            "Web Push nudges attempted, by outcome. All-failed usually means a lost \
             VAPID key — see the runbook.",
            "outcome",
            &[("sent", self.push_sent.get()), ("failed", self.push_failed.get())],
        );

        counter(
            &mut out,
            "quorum_blobs_uploaded_total",
            "Attachment blobs accepted.",
            self.blobs_uploaded.get(),
        );
        counter(
            &mut out,
            "quorum_blob_bytes_total",
            "Bytes of attachment ciphertext accepted. Nothing deletes these yet.",
            self.blob_bytes.get(),
        );
        counter(
            &mut out,
            "quorum_blob_tickets_refused_total",
            "Blob PUTs without a valid single-use ticket.",
            self.blob_tickets_refused.get(),
        );
        counter(
            &mut out,
            "quorum_subscribers_dropped_total",
            "Subscribers disconnected for exceeding their outbound queue. Recoverable \
             (they resubscribe from their last seq) but indistinguishable from a lost \
             message to the person it happens to.",
            self.subscribers_dropped.get(),
        );
        self.append_latency.render(
            &mut out,
            "quorum_append_duration_seconds",
            "Time to append one message to the log, including any wait for the group's send lock.",
        );
        counter(
            &mut out,
            "quorum_blobs_swept_total",
            "Attachments deleted for exceeding BLOB_TTL_DAYS. Flat at zero when the \
             setting is unset, which is the default.",
            self.blobs_swept.get(),
        );
        counter(
            &mut out,
            "quorum_history_swept_total",
            "Expired kept-history rows removed. Flat at zero means the sweep is not running.",
            self.history_swept.get(),
        );

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> String {
        let m = Metrics::default();
        m.ws_connections.add(3);
        m.auth_failures.bad_signature.inc();
        m.send_rejections.epoch_conflict.add(2);
        m.blob_bytes.add(4096);
        m.render(Snapshot { clients_online: 7, groups_subscribed: 2 })
    }

    #[test]
    fn counters_and_gauges_render_their_values() {
        let out = body();
        assert!(out.contains("\nquorum_ws_connections_total 3\n"), "{out}");
        assert!(out.contains("\nquorum_clients_online 7\n"), "{out}");
        assert!(out.contains("\nquorum_blob_bytes_total 4096\n"), "{out}");
    }

    #[test]
    fn labelled_families_carry_every_label() {
        let out = body();
        assert!(out.contains("quorum_ws_auth_failures_total{reason=\"bad_signature\"} 1"), "{out}");
        // Zeroes are emitted too: a label that only appears once it is
        // non-zero cannot be alerted on, because the series does not exist
        // until the incident has already started.
        assert!(out.contains("quorum_ws_auth_failures_total{reason=\"unregistered\"} 0"), "{out}");
        assert!(out.contains("quorum_send_rejections_total{reason=\"epoch_conflict\"} 2"), "{out}");
    }

    #[test]
    fn each_family_declares_help_and_type_exactly_once() {
        // Repeating HELP/TYPE within a family is a parse error in strict
        // scrapers, and it is the easy mistake when emitting labels in a loop.
        let out = body();
        for family in [
            "quorum_ws_auth_failures_total",
            "quorum_send_rejections_total",
            "quorum_welcomes_total",
            "quorum_push_total",
        ] {
            assert_eq!(
                out.matches(&format!("# TYPE {family} ")).count(),
                1,
                "{family} declared more than once:\n{out}"
            );
        }
    }

    #[test]
    fn every_metric_is_documented() {
        // A metric with no HELP is a metric nobody on call can interpret.
        let out = body();
        let names: Vec<&str> = out
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
            .map(|l| l.split(['{', ' ']).next().unwrap_or_default())
            .collect();
        for name in names {
            // A histogram documents its family once; _bucket/_sum/_count are
            // sub-series of it, not metrics in their own right.
            let family = name
                .strip_suffix("_bucket")
                .or_else(|| name.strip_suffix("_sum"))
                .or_else(|| name.strip_suffix("_count"))
                .unwrap_or(name);
            assert!(
                out.contains(&format!("# HELP {family} ")),
                "{name} has no HELP line"
            );
        }
    }

    #[test]
    fn a_latency_sample_lands_in_exactly_one_bucket_and_all_above_it() {
        // Prometheus buckets are cumulative. Getting this wrong produces a
        // histogram that parses and quietly reports nonsense.
        let m = Metrics::default();
        m.append_latency.observe_ms(7);
        let out = m.render(Snapshot::default());
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"0.005\"} 0"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"0.01\"} 1"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"5\"} 1"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"+Inf\"} 1"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_count 1"), "{out}");
    }

    #[test]
    fn a_sample_past_the_last_bucket_still_counts() {
        // The slowest appends are the ones worth alerting on; dropping them
        // would make the tail look clean precisely when it is not.
        let m = Metrics::default();
        m.append_latency.observe_ms(30_000);
        let out = m.render(Snapshot::default());
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"5\"} 0"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_bucket{le=\"+Inf\"} 1"), "{out}");
        assert!(out.contains("quorum_append_duration_seconds_count 1"), "{out}");
        // Seconds, not milliseconds: every alert expression assumes base units.
        assert!(out.contains("quorum_append_duration_seconds_sum 30"), "{out}");
    }

    #[test]
    fn an_untouched_histogram_still_publishes_its_series() {
        // A series that appears only once it is non-zero cannot be graphed or
        // alerted on before the incident that creates it.
        let out = body();
        assert!(out.contains("quorum_append_duration_seconds_count 0"), "{out}");
        assert!(out.contains("# TYPE quorum_append_duration_seconds histogram"), "{out}");
    }

    #[test]
    fn exposition_is_newline_terminated() {
        // A scrape that does not end in a newline is truncated for some
        // parsers, dropping the last metric silently.
        assert!(body().ends_with('\n'));
    }
}
