//! Direct contract tests for `MemoryStore` — the in-memory `Store` impl that
//! backs `cargo test` and zero-config runs. The Postgres impl has its own
//! contract tests (pg_store.rs) but those are skipped without a database;
//! these exercise the same surface with no external dependency, so the
//! default `cargo test` covers store semantics on their own.

use relay::store::{
    InviteRecord, MemoryStore, RegisterOutcome, Store, StoreError, StoredWelcome, VaultRecord,
};

fn store() -> MemoryStore {
    MemoryStore::default()
}

#[tokio::test]
async fn register_pins_the_first_key_and_never_overwrites() {
    let s = store();
    assert_eq!(s.register_user("alice", b"key-1").await.unwrap(), RegisterOutcome::Registered);
    assert_eq!(
        s.register_user("alice", b"key-2").await.unwrap(),
        RegisterOutcome::Existing(b"key-1".to_vec()),
    );
    assert_eq!(s.get_user_pubkey("alice").await.unwrap(), Some(b"key-1".to_vec()));
    assert_eq!(s.get_user_pubkey("nobody").await.unwrap(), None);
}

#[tokio::test]
async fn key_packages_consume_fifo_then_run_dry() {
    let s = store();
    // No packages yet -> None, not an error.
    assert_eq!(s.take_key_package("bob").await.unwrap(), None);
    s.publish_key_packages("bob", vec![b"kp1".to_vec(), b"kp2".to_vec()]).await.unwrap();
    s.publish_key_packages("bob", vec![b"kp3".to_vec()]).await.unwrap();
    assert_eq!(s.take_key_package("bob").await.unwrap(), Some(b"kp1".to_vec()));
    assert_eq!(s.take_key_package("bob").await.unwrap(), Some(b"kp2".to_vec()));
    assert_eq!(s.take_key_package("bob").await.unwrap(), Some(b"kp3".to_vec()));
    assert_eq!(s.take_key_package("bob").await.unwrap(), None, "exhausted store yields None");
}

#[tokio::test]
async fn membership_and_allow_are_idempotent() {
    let s = store();
    s.create_group("g1", "alice").await.unwrap();
    assert!(matches!(s.create_group("g1", "alice").await, Err(StoreError::GroupExists)));

    assert!(s.is_member("g1", "alice").await.unwrap(), "creator is a member");
    assert!(!s.is_member("g1", "bob").await.unwrap());
    assert!(!s.is_member("missing", "alice").await.unwrap(), "unknown group -> not a member");

    s.allow_member("g1", "bob").await.unwrap();
    s.allow_member("g1", "bob").await.unwrap(); // idempotent, no duplicate
    // Creator is admin; an allowed member joins as a plain member.
    assert_eq!(
        s.group_members("g1").await.unwrap(),
        vec![
            ("alice".to_string(), "admin".to_string()),
            ("bob".to_string(), "member".to_string()),
        ],
    );

    assert!(matches!(s.allow_member("missing", "bob").await, Err(StoreError::NoSuchGroup)));
    assert!(matches!(s.group_members("missing").await, Err(StoreError::NoSuchGroup)));
}

#[tokio::test]
async fn message_log_assigns_ascending_seqs_and_filters_after() {
    let s = store();
    assert!(
        matches!(s.append_message("missing", 1, "alice", b"x".to_vec()).await, Err(StoreError::NoSuchGroup)),
        "cannot append to a group that does not exist"
    );
    s.create_group("g1", "alice").await.unwrap();
    assert_eq!(s.append_message("g1", 1, "alice", b"m1".to_vec()).await.unwrap(), 1);
    assert_eq!(s.append_message("g1", 1, "bob", b"m2".to_vec()).await.unwrap(), 2);
    assert_eq!(s.append_message("g1", 2, "alice", b"m3".to_vec()).await.unwrap(), 3);

    assert_eq!(s.messages_after("g1", 0).await.unwrap().len(), 3, "after=0 returns everything");
    let tail = s.messages_after("g1", 1).await.unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!((tail[0].seq, tail[0].sender.as_str()), (2, "bob"));
    assert_eq!((tail[1].seq, tail[1].epoch), (3, 2));
    assert!(s.messages_after("g1", 99).await.unwrap().is_empty(), "past the tail is empty");
    assert!(matches!(s.messages_after("missing", 0).await, Err(StoreError::NoSuchGroup)));
}

#[tokio::test]
async fn welcomes_queue_in_order_and_drain_once() {
    let s = store();
    let w = |n: u64| StoredWelcome {
        from: "alice".into(),
        group: "g1".into(),
        after: n,
        payload: vec![n as u8],
    };
    assert!(s.take_welcomes("carol").await.unwrap().is_empty(), "no welcomes -> empty");
    s.store_welcome("carol", w(1)).await.unwrap();
    s.store_welcome("carol", w(2)).await.unwrap();
    let drained = s.take_welcomes("carol").await.unwrap();
    assert_eq!(drained.iter().map(|w| w.after).collect::<Vec<_>>(), vec![1, 2]);
    assert!(s.take_welcomes("carol").await.unwrap().is_empty(), "draining consumes");
}

#[tokio::test]
async fn invite_expiry_boundary_and_use_counting() {
    let s = store();
    s.create_group("g1", "alice").await.unwrap();
    let rec = |max_uses, expires_at| InviteRecord {
        group: "g1".into(),
        payload: b"blob".to_vec(),
        expires_at,
        max_uses,
        uses: 0,
    };

    // Unknown group is refused at creation.
    let mut orphan = rec(None, None);
    orphan.group = "nope".into();
    assert!(matches!(s.create_invite("bad", orphan).await, Err(StoreError::NoSuchGroup)));

    // Expiry is inclusive of the exact second: expired only when now > expires_at.
    s.create_invite("timed", rec(None, Some(500))).await.unwrap();
    assert!(s.redeem_invite("timed", 499).await.is_ok(), "before expiry");
    assert!(s.redeem_invite("timed", 500).await.is_ok(), "exactly at expiry is still valid");
    assert!(s.redeem_invite("timed", 501).await.is_err(), "one second past expiry is invalid");

    // max_uses counts and then refuses.
    s.create_invite("twice", rec(Some(2), None)).await.unwrap();
    assert!(s.redeem_invite("twice", 0).await.is_ok());
    assert!(s.redeem_invite("twice", 0).await.is_ok());
    assert!(s.redeem_invite("twice", 0).await.is_err(), "third redemption exceeds max_uses");

    // update swaps the blob under the same id; revoke removes it entirely.
    s.create_invite("live", rec(None, None)).await.unwrap();
    s.update_invite("live", b"blob-v2".to_vec()).await.unwrap();
    assert_eq!(s.redeem_invite("live", 0).await.unwrap().1, b"blob-v2");
    assert_eq!(s.invite_group("live").await.unwrap().as_deref(), Some("g1"));
    s.revoke_invite("live").await.unwrap();
    assert!(s.invite_group("live").await.unwrap().is_none());
    assert!(matches!(s.redeem_invite("live", 0).await, Err(StoreError::InviteInvalid)));

    // Operations on a missing invite are InviteInvalid, not a panic.
    assert!(matches!(s.update_invite("ghost", b"x".to_vec()).await, Err(StoreError::InviteInvalid)));
    assert!(matches!(s.redeem_invite("ghost", 0).await, Err(StoreError::InviteInvalid)));
    // Revoking something already gone is a no-op success.
    assert!(s.revoke_invite("ghost").await.is_ok());
}

#[tokio::test]
async fn vault_set_get_and_overwrite() {
    let s = store();
    assert!(s.get_vault("alice").await.unwrap().is_none());
    let v1 = VaultRecord {
        kind: "password".into(),
        salt: b"salt".to_vec(),
        verifier: b"verify".to_vec(),
        wrapped: b"blob".to_vec(),
        credential: None,
    };
    s.set_vault("alice", v1).await.unwrap();
    assert_eq!(s.get_vault("alice").await.unwrap().unwrap().kind, "password");
    // Re-setting replaces (e.g. password -> passkey migration).
    let v2 = VaultRecord {
        kind: "passkey".into(),
        salt: b"salt2".to_vec(),
        verifier: Vec::new(),
        wrapped: b"blob2".to_vec(),
        credential: Some("cred".into()),
    };
    s.set_vault("alice", v2).await.unwrap();
    let got = s.get_vault("alice").await.unwrap().unwrap();
    assert_eq!(got.kind, "passkey");
    assert_eq!(got.credential.as_deref(), Some("cred"));
}

#[tokio::test]
async fn push_subscriptions_are_keyed_by_endpoint() {
    let s = store();
    assert!(s.push_subscriptions_for("alice").await.unwrap().is_empty());
    s.put_push_subscription("alice", "https://a", "sub-a").await.unwrap();
    s.put_push_subscription("alice", "https://b", "sub-b").await.unwrap();
    // Same endpoint replaces, doesn't duplicate.
    s.put_push_subscription("alice", "https://a", "sub-a2").await.unwrap();
    let subs = s.push_subscriptions_for("alice").await.unwrap();
    assert_eq!(subs.len(), 2, "two distinct endpoints");
    assert!(subs.iter().any(|(ep, body)| ep == "https://a" && body == "sub-a2"));

    s.delete_push_subscription("alice", "https://a").await.unwrap();
    let subs = s.push_subscriptions_for("alice").await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].0, "https://b");
    // Deleting a missing endpoint is a no-op.
    assert!(s.delete_push_subscription("alice", "https://gone").await.is_ok());
}
