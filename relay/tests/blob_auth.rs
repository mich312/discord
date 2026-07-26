//! The blob PUT is the relay's only *unauthenticated* write, so it is the
//! only place a stranger can spend the operator's disk. A blob id is a read
//! capability — it says nothing about who may write — and before upload
//! tickets existed anyone on the internet could PUT 25 MiB per request into
//! the volume shared with Postgres until the disk filled and the database
//! went down with it.
//!
//! `push_and_blobs.rs` covers the store's own put/get semantics. These cover
//! the authorization around it, over real HTTP through the actual router.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use relay::blobs::{BlobStore, MAX_BLOB_BYTES};
use relay::push::PushService;
use relay::server::App;
use relay::store::MemoryStore;
use relay::UPLOAD_TICKET_HEADER;
use std::sync::Arc;
use tower::ServiceExt;

fn app() -> Arc<App> {
    let blobs = BlobStore::new(tempfile::tempdir().unwrap().keep()).unwrap();
    App::with_parts(Box::new(MemoryStore::default()), blobs, PushService::from_env(), true)
}

async fn put(app: &Arc<App>, id: &str, ticket: Option<&str>, body: Vec<u8>) -> StatusCode {
    let mut req = Request::builder().method("PUT").uri(format!("/blobs/{id}"));
    if let Some(t) = ticket {
        req = req.header(UPLOAD_TICKET_HEADER, t);
    }
    relay::router(app.clone())
        .oneshot(req.body(Body::from(body)).unwrap())
        .await
        .unwrap()
        .status()
}

async fn get(app: &Arc<App>, id: &str) -> (StatusCode, Vec<u8>) {
    let res = relay::router(app.clone())
        .oneshot(Request::builder().uri(format!("/blobs/{id}")).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), MAX_BLOB_BYTES + 4096).await.unwrap();
    (status, bytes.to_vec())
}

#[tokio::test]
async fn an_upload_without_a_ticket_is_refused() {
    // The whole point. Knowing (or guessing) an id must not grant write.
    let app = app();
    assert_eq!(put(&app, "some-id", None, b"payload".to_vec()).await, StatusCode::FORBIDDEN);
    assert_eq!(put(&app, "some-id", Some(""), b"x".to_vec()).await, StatusCode::FORBIDDEN);
    assert_eq!(put(&app, "some-id", Some("invented"), b"x".to_vec()).await, StatusCode::FORBIDDEN);
    assert_eq!(get(&app, "some-id").await.0, StatusCode::NOT_FOUND, "nothing was written");
}

#[tokio::test]
async fn a_ticket_authorizes_exactly_one_upload_of_exactly_one_id() {
    let app = app();
    let ticket = app.blob_tickets.mint("mine");

    // Not a licence to write elsewhere.
    assert_eq!(
        put(&app, "someone-elses", Some(&ticket), b"x".to_vec()).await,
        StatusCode::FORBIDDEN,
        "a ticket is bound to the id it was minted for"
    );

    assert_eq!(put(&app, "mine", Some(&ticket), b"payload".to_vec()).await, StatusCode::CREATED);

    // Spent. Otherwise one ticket is an unbounded write budget.
    assert_eq!(
        put(&app, "mine", Some(&ticket), b"again".to_vec()).await,
        StatusCode::FORBIDDEN,
        "a ticket is single-use"
    );

    let (status, body) = get(&app, "mine").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"payload", "and the first write is what stuck");
}

#[tokio::test]
async fn refused_uploads_are_counted() {
    // An operator watching quorum_blob_tickets_refused_total is watching for
    // exactly this; a silent refusal looks identical to no traffic.
    let app = app();
    assert_eq!(app.metrics.blob_tickets_refused.get(), 0);
    put(&app, "some-id", None, b"x".to_vec()).await;
    put(&app, "some-id", Some("invented"), b"x".to_vec()).await;
    assert_eq!(app.metrics.blob_tickets_refused.get(), 2);
    assert_eq!(app.metrics.blobs_uploaded.get(), 0);
}

#[tokio::test]
async fn an_oversized_upload_is_rejected_by_the_body_limit() {
    // The size cap has to hold even *with* a valid ticket, or a legitimate
    // member is enough to fill the disk. The router's body limit sits in
    // front of the handler, so this never reaches the filesystem.
    let app = app();
    let ticket = app.blob_tickets.mint("big");
    let status = put(&app, "big", Some(&ticket), vec![0u8; MAX_BLOB_BYTES + 8192]).await;
    assert_ne!(status, StatusCode::CREATED, "an oversized body must not be stored");
    assert_eq!(get(&app, "big").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_blob_id_cannot_escape_the_blob_directory() {
    // Ids become path components. Anything outside the token alphabet is
    // refused before it can be joined onto the storage directory.
    let app = app();
    for id in ["..", "..%2f..%2fetc%2fpasswd", "with.dot", "with%20space"] {
        let ticket = app.blob_tickets.mint(id);
        let status = put(&app, id, Some(&ticket), b"x".to_vec()).await;
        assert_ne!(status, StatusCode::CREATED, "id {id:?} must not be writable");
    }
}

#[tokio::test]
async fn a_ticket_for_an_unwritable_id_still_cannot_write_it() {
    // Minting is unauthenticated in the sense that any *member* can ask for
    // one; the id validation is what stops a hostile member aiming it
    // somewhere it should not go.
    let app = app();
    let ticket = app.blob_tickets.mint("../escape");
    assert_ne!(
        put(&app, "../escape", Some(&ticket), b"x".to_vec()).await,
        StatusCode::CREATED
    );
}
