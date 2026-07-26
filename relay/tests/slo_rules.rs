//! The alerting rules are checked against the metrics the relay actually
//! emits.
//!
//! A Prometheus rule that names a metric nobody exports is not an error. It
//! evaluates to the empty vector, forever, and the alert simply never fires —
//! so the first time anyone finds out is during the incident it existed to
//! catch. Renaming a metric in `metrics.rs` is a one-line change that silently
//! disarms an alert, and nothing else in this repository would notice.
//!
//! This reads the YAML as text rather than parsing it. The question is "does
//! this identifier exist", and the structure is irrelevant to that — parsing
//! would mean adding a YAML dependency to a crypto stack to learn nothing
//! extra.

use relay::metrics::{Metrics, Snapshot};
use std::collections::BTreeSet;

const RULE_FILES: [&str; 2] = ["../deploy/alerts.yml", "../deploy/slo-rules.yml"];

fn read(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every `quorum_*` identifier a rule file mentions.
fn referenced(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(at) = text[i..].find("quorum_") {
        let start = i + at;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        // A bare `quorum_` — the prefix written in prose, as in "a quorum_
        // name" — is not a reference to anything. Without this, a comment
        // mentioning the prefix fails the check against a metric that was
        // never named.
        if end > start + "quorum_".len() {
            out.insert(text[start..end].to_string());
        }
        i = end;
    }
    out
}

/// Every metric family name the exposition actually contains, taken from a
/// real render rather than from a hand-kept list — a hand-kept list is the
/// thing that goes stale.
fn exported() -> BTreeSet<String> {
    let body = Metrics::default().render(Snapshot::default());
    let mut out = BTreeSet::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("# TYPE ") {
            if let Some(name) = rest.split_whitespace().next() {
                out.insert(name.to_string());
            }
        }
    }
    out
}

#[test]
fn the_extractor_finds_names_the_relay_does_not_export() {
    // The guard above is only worth having if it can fail, and passing on
    // correct input proves nothing about that. So drive the two halves with
    // synthetic input: a made-up metric must be extracted (or a rename would
    // slip through unseen), and it must not be in the exported set.
    let names = referenced(
        r#"
        expr: sum(rate(quorum_messages_appended_total[5m]))
              / sum(rate(quorum_invented_metric_total[5m]))
        summary: "up{job=\"quorum\"} is not a quorum_ name"
        "#,
    );
    assert!(names.contains("quorum_messages_appended_total"), "real names are found: {names:?}");
    assert!(names.contains("quorum_invented_metric_total"), "invented names are found too");
    assert!(
        !names.contains("quorum"),
        "the bare label value in up{{job=\"quorum\"}} is not a metric reference: {names:?}"
    );
    assert!(
        !names.contains("quorum_"),
        "the prefix written in prose is not a reference either, or a comment \
         mentioning it fails the check against a metric nobody named: {names:?}"
    );

    let exported = exported();
    assert!(exported.contains("quorum_messages_appended_total"));
    assert!(
        !exported.contains("quorum_invented_metric_total"),
        "the check would not fail on a metric that does not exist"
    );
}

#[test]
fn every_metric_the_rules_reference_is_one_the_relay_emits() {
    let exported = exported();
    assert!(!exported.is_empty(), "the exposition declared no TYPE lines at all");

    for file in RULE_FILES {
        for name in referenced(&read(file)) {
            // Histogram sub-series are not families of their own.
            let family = name
                .strip_suffix("_bucket")
                .or_else(|| name.strip_suffix("_sum"))
                .or_else(|| name.strip_suffix("_count"))
                .unwrap_or(name.as_str());
            assert!(
                exported.contains(family),
                "{file} references `{name}`, which the relay does not export.\n\
                 A rule naming a metric that does not exist never fires.\n\
                 Exported: {exported:?}",
            );
        }
    }
}

#[test]
fn the_recorded_slis_use_a_bucket_boundary_that_exists() {
    // `le="1"` is not a threshold Prometheus interpolates — it either matches
    // a boundary this histogram declares or it selects nothing. The value is
    // rendered from a float (1000ms / 1000.0), so "1" and "1.0" are not
    // interchangeable and only one of them is what gets scraped.
    let body = Metrics::default().render(Snapshot::default());
    let rules = read("../deploy/slo-rules.yml");
    assert!(
        rules.contains(r#"quorum_append_duration_seconds_bucket{le="1"}"#),
        "the latency SLI should select the 1s boundary"
    );
    assert!(
        body.contains(r#"quorum_append_duration_seconds_bucket{le="1"}"#),
        "the exposition does not declare an le=\"1\" bucket, so the SLI selects nothing"
    );
}

#[test]
fn the_send_acceptance_sli_excludes_epoch_conflicts() {
    // The tempting mistake, and the one worth a test rather than a comment:
    // counting epoch conflicts as errors would make this objective improve as
    // §1.1's fork protection gets *worse*, and would push whoever owns the
    // number toward weakening the check that keeps circles from forking.
    let rules = read("../deploy/slo-rules.yml");
    let sli: Vec<&str> = rules
        .lines()
        .filter(|l| l.contains("quorum_send_rejections_total{"))
        .collect();
    assert!(!sli.is_empty(), "no labelled send-rejection selector found");
    for line in sli {
        assert!(
            line.contains(r#"reason="backend""#),
            "the only rejection reason charged to the budget should be `backend`, got: {line}"
        );
    }
}

#[test]
fn every_burn_alert_names_a_recorded_rule_that_exists() {
    // A burn alert referring to a recording rule that was renamed or never
    // added fails exactly the same silent way as a missing metric.
    let rules = read("../deploy/slo-rules.yml");
    let recorded: BTreeSet<&str> = rules
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- record: "))
        .map(str::trim)
        .collect();
    assert!(recorded.len() >= 12, "expected the SLI recording rules, found {recorded:?}");

    let mut referenced = BTreeSet::new();
    let mut i = 0;
    while let Some(at) = rules[i..].find("quorum:") {
        let start = i + at;
        let bytes = rules.as_bytes();
        let mut end = start;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b':')
        {
            end += 1;
        }
        referenced.insert(&rules[start..end]);
        i = end;
    }
    for name in referenced {
        assert!(
            recorded.contains(name),
            "`{name}` is used but never recorded; it would evaluate to nothing"
        );
    }
}
