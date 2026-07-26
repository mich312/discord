//! The `/metrics` endpoint.
//!
//! Every number it serves is metadata — who is online, how many circles
//! exist, how fast they are talking — and metadata is the one thing this
//! design concedes to the operator and to nobody else. So the access rules
//! matter more than the numbers, and they are what is covered here.
//!
//! Deliberately one test in its own binary: `METRICS_TOKEN` is process-wide,
//! and tests in the same binary run on threads that would race each other
//! setting and clearing it.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use relay::blobs::BlobStore;
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use tower::ServiceExt;

async fn get(app: &std::sync::Arc<App>, auth: Option<&str>) -> (StatusCode, String) {
    let mut req = Request::builder().uri("/metrics").method("GET");
    if let Some(value) = auth {
        req = req.header("authorization", value);
    }
    let response =
        relay::router(app.clone()).oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn metrics_are_off_by_default_and_bearer_gated_when_on() {
    let blobs = BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap();
    let app =
        App::with_parts(Box::new(MemoryStore::default()), blobs, PushService::from_env(), true);

    // --- unconfigured -----------------------------------------------------
    std::env::remove_var("METRICS_TOKEN");
    let (status, _) = get(&app, None).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "an unconfigured relay must not expose metrics at all"
    );

    // An empty token is a configuration mistake, not permission to serve
    // metrics to everyone.
    std::env::set_var("METRICS_TOKEN", "");
    let (status, _) = get(&app, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an empty token must not open the endpoint");

    // --- configured -------------------------------------------------------
    std::env::set_var("METRICS_TOKEN", "s3cret-scrape-token");

    let (status, _) = get(&app, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no credential, no metrics");

    let (status, _) = get(&app, Some("Bearer wrong")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a wrong token is refused");

    // A token that is a prefix of the real one must not pass: the length
    // check has to come before the comparison, not after it.
    let (status, _) = get(&app, Some("Bearer s3cret")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a prefix of the token is not the token");

    let (status, _) = get(&app, Some("s3cret-scrape-token")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the Bearer scheme is required");

    // --- authorised -------------------------------------------------------
    let (status, body) = get(&app, Some("Bearer s3cret-scrape-token")).await;
    assert_eq!(status, StatusCode::OK);

    // Shape, not values: a scraper that cannot parse this gets nothing, and
    // a metric with no HELP is one nobody on call can interpret.
    assert!(body.contains("# HELP quorum_up"), "{body}");
    assert!(body.contains("# TYPE quorum_clients_online gauge"), "{body}");
    assert!(body.contains("\nquorum_clients_online 0\n"), "{body}");
    assert!(body.contains("quorum_ws_auth_failures_total{reason=\"bad_signature\"}"), "{body}");
    assert!(body.ends_with('\n'), "a truncated scrape silently drops its last metric");

    // The relay is idle, so the counters must be at zero rather than absent.
    // A series that only appears once it is non-zero cannot be alerted on.
    assert!(body.contains("\nquorum_messages_appended_total 0\n"), "{body}");

    std::env::remove_var("METRICS_TOKEN");
}
