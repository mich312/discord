//! PgStore contract tests. Skipped unless TEST_DATABASE_URL is set, e.g.:
//!   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1/relay_test cargo test -p relay
//! Each run uses uniquely-named rows so reruns don't collide.

use relay::pg::PgStore;
use relay::store::{RegisterOutcome, Store, StoredWelcome};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos();
    format!("{prefix}-{}-{}-{nanos}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

async fn store() -> Option<PgStore> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(PgStore::connect(&url).await.expect("postgres reachable"))
}

macro_rules! require_store {
    () => {
        match store().await {
            Some(s) => s,
            None => {
                eprintln!("TEST_DATABASE_URL not set — skipping postgres test");
                return;
            }
        }
    };
}

#[tokio::test]
async fn user_registration_pins_first_key() {
    let s = require_store!();
    let user = unique("alice");
    assert_eq!(s.register_user(&user, b"key-1").await.unwrap(), RegisterOutcome::Registered);
    assert_eq!(
        s.register_user(&user, b"key-2").await.unwrap(),
        RegisterOutcome::Existing(b"key-1".to_vec()),
        "second registration must return the pinned key, not overwrite it"
    );
    assert_eq!(s.get_user_pubkey(&user).await.unwrap(), Some(b"key-1".to_vec()));
}

#[tokio::test]
async fn key_packages_consume_in_order() {
    let s = require_store!();
    let user = unique("bob");
    s.register_user(&user, b"k").await.unwrap();
    s.publish_key_packages(&user, vec![b"kp1".to_vec(), b"kp2".to_vec()]).await.unwrap();
    assert_eq!(s.take_key_package(&user).await.unwrap(), Some(b"kp1".to_vec()));
    assert_eq!(s.take_key_package(&user).await.unwrap(), Some(b"kp2".to_vec()));
    assert_eq!(s.take_key_package(&user).await.unwrap(), None);
}

#[tokio::test]
async fn message_log_assigns_ordered_seqs() {
    let s = require_store!();
    let group = unique("g");
    s.create_group(&group, "alice").await.unwrap();
    assert!(s.create_group(&group, "alice").await.is_err(), "duplicate group must fail");

    assert_eq!(s.append_message(&group, 1, "alice", b"m1".to_vec()).await.unwrap(), 1);
    assert_eq!(s.append_message(&group, 1, "alice", b"m2".to_vec()).await.unwrap(), 2);
    assert_eq!(s.append_message(&group, 2, "bob", b"m3".to_vec()).await.unwrap(), 3);

    let tail = s.messages_after(&group, 1).await.unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!((tail[0].seq, tail[0].epoch), (2, 1));
    assert_eq!((tail[1].seq, tail[1].epoch, tail[1].sender.as_str()), (3, 2, "bob"));
}

#[tokio::test]
async fn membership_acl_roundtrip() {
    let s = require_store!();
    let group = unique("g");
    s.create_group(&group, "alice").await.unwrap();
    assert!(s.is_member(&group, "alice").await.unwrap(), "creator is a member");
    assert!(!s.is_member(&group, "bob").await.unwrap());
    s.allow_member(&group, "bob").await.unwrap();
    assert!(s.is_member(&group, "bob").await.unwrap());
    assert!(s.allow_member(&unique("missing"), "bob").await.is_err());
}

#[tokio::test]
async fn welcomes_queue_and_drain() {
    let s = require_store!();
    let to = unique("carol");
    let w = |n: u64| StoredWelcome {
        from: "alice".into(),
        group: "g1".into(),
        after: n,
        payload: format!("w{n}").into_bytes(),
    };
    s.store_welcome(&to, w(1)).await.unwrap();
    s.store_welcome(&to, w(2)).await.unwrap();
    let drained = s.take_welcomes(&to).await.unwrap();
    assert_eq!(drained.len(), 2);
    assert_eq!(drained[0].after, 1);
    assert_eq!(drained[1].after, 2);
    assert!(s.take_welcomes(&to).await.unwrap().is_empty(), "drain must consume");
}
