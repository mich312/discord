//! Edge cases and error paths for the MLS core: the "unhappy" side of the
//! flows that `mls_flow.rs` proves work. These pin down that misuse is
//! rejected cleanly (a returned `Err`) rather than panicking or corrupting
//! state — the client must survive hostile or malformed input from the relay.

use crypto_core::{ChatClient, Event};

const G: &str = "grp-edge";

#[test]
fn creating_the_same_group_twice_is_rejected() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();
    assert!(alice.create_group(G).is_err(), "second create must fail, not clobber the first");
}

#[test]
fn operations_on_an_unknown_group_error_cleanly() {
    let mut alice = ChatClient::new("alice").unwrap();
    let bob = ChatClient::new("bob").unwrap();

    // None of these must panic; every one returns Err for a group we're not in.
    assert!(alice.epoch(G).is_err());
    assert!(alice.members(G).is_err());
    assert!(alice.send_message(G, "hi").is_err());
    assert!(alice.export_group_info(G).is_err());
    assert!(alice.remove_member(G, "bob").is_err());
    assert!(alice.add_member(G, &bob.key_package().unwrap()).is_err());
    assert!(alice.safety_number(G, "bob").is_err());
}

#[test]
fn process_incoming_for_a_group_we_are_not_in_errors() {
    // alice runs a group bob is not part of; bob must reject its traffic.
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();
    let blob = alice.send_message(G, "not for you").unwrap();
    assert!(bob.process_incoming(&blob).is_err());
}

#[test]
fn malformed_welcome_and_group_info_are_rejected() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();

    // Garbage bytes: neither a Welcome nor a GroupInfo.
    assert!(alice.join_from_welcome(b"not-an-mls-message").is_err());
    assert!(alice.join_by_external_commit(b"still-garbage").is_err());

    // A well-formed GroupInfo is not a Welcome, and vice versa — feeding one
    // to the other entry point must fail rather than half-join.
    let group_info = alice.export_group_info(G).unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();
    assert!(charlie.join_from_welcome(&group_info).is_err());
}

#[test]
fn removing_a_nonexistent_member_errors() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();
    assert!(alice.remove_member(G, "ghost").is_err(), "removing a non-member must fail");
}

#[test]
fn joining_the_same_welcome_twice_is_rejected() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();
    let add = alice.add_member(G, &bob.key_package().unwrap()).unwrap();

    assert_eq!(bob.join_from_welcome(&add.welcome).unwrap(), G);
    // Replaying the same Welcome must not silently re-join or overwrite state.
    assert!(bob.join_from_welcome(&add.welcome).is_err(), "double-join must be refused");
}

#[test]
fn each_key_package_is_distinct() {
    let bob = ChatClient::new("bob").unwrap();
    let kp1 = bob.key_package().unwrap();
    let kp2 = bob.key_package().unwrap();
    assert_ne!(kp1, kp2, "every KeyPackage must be freshly generated (one-time use)");
}

#[test]
fn forget_group_drops_it_from_state() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group("team").unwrap();
    alice.create_group("club").unwrap();
    assert_eq!(alice.group_ids(), vec!["club", "team"]);

    alice.forget_group("team");
    assert_eq!(alice.group_ids(), vec!["club"]);
    assert!(alice.epoch("team").is_err(), "a forgotten group is gone entirely");
    // The surviving group still works.
    assert!(alice.send_message("club", "still here").is_ok());
}

#[test]
fn import_state_rejects_corrupt_bundles() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();
    let good = alice.export_state().unwrap();

    // Truncation at every prefix must yield Err, never a panic.
    for cut in [0usize, 1, 3, 8, good.len() / 2, good.len().saturating_sub(1)] {
        assert!(ChatClient::import_state(&good[..cut]).is_err(), "truncated at {cut} must fail");
    }
    // Random noise of the right sort of length is also rejected.
    assert!(ChatClient::import_state(&vec![0xABu8; good.len()]).is_err());
    // The untouched bundle still restores.
    assert!(ChatClient::import_state(&good).is_ok());
}

#[test]
fn import_identity_rejects_garbage() {
    assert!(ChatClient::import_identity(b"").is_err());
    assert!(ChatClient::import_identity(b"{not json}").is_err());
    // Valid JSON but the wrong shape.
    assert!(ChatClient::import_identity(br#"{"v":1}"#).is_err());
    // A version we don't support.
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();
    let mut bundle: serde_json::Value =
        serde_json::from_slice(&alice.export_identity().unwrap()).unwrap_or(serde_json::json!({}));
    if bundle.get("v").is_some() {
        bundle["v"] = serde_json::json!(999);
        assert!(ChatClient::import_identity(bundle.to_string().as_bytes()).is_err());
    }
}

#[test]
fn a_stale_epoch_message_does_not_wedge_the_receiver() {
    // A message from a past epoch must fail to decrypt but leave the client
    // able to process the next valid message (no poisoned state).
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();
    alice.create_group(G).unwrap();
    let add_bob = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    let stale = bob.send_message(G, "epoch 1").unwrap();
    let add_charlie = alice.add_member(G, &charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();
    // charlie never held epoch-1 keys.
    assert!(charlie.process_incoming(&stale).is_err());
    // …and he still merges the commit and reads fresh traffic afterwards.
    let blob = alice.send_message(G, "epoch 2").unwrap();
    match charlie.process_incoming(&blob).unwrap() {
        Event::Message { text, .. } => assert_eq!(text, "epoch 2"),
        other => panic!("expected message, got {other:?}"),
    }
}
