//! Native integration tests for the MLS core: everything that must work
//! before the browser is involved. All inter-client traffic goes through
//! serialized byte blobs, exactly as it will over the relay.

use crypto_core::{ChatClient, Event};

const G: &str = "grp-test";

fn expect_message(event: Event, sender: &str, text: &str) {
    match event {
        Event::Message { sender: s, text: t, .. } => {
            assert_eq!(s, sender);
            assert_eq!(t, text);
        }
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn two_party_create_join_exchange() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();

    alice.create_group(G).unwrap();
    assert_eq!(alice.epoch(G).unwrap(), 0);

    // bob publishes a KeyPackage; alice adds him.
    let bob_kp = bob.key_package().unwrap();
    let add = alice.add_member(G, &bob_kp).unwrap();
    assert_eq!(alice.epoch(G).unwrap(), 1);

    // bob joins from the Welcome; the group id travels inside it.
    let joined = bob.join_from_welcome(&add.welcome).unwrap();
    assert_eq!(joined, G);
    assert_eq!(bob.epoch(G).unwrap(), 1);
    assert_eq!(bob.members(G).unwrap(), vec!["alice", "bob"]);
    assert_eq!(alice.members(G).unwrap(), vec!["alice", "bob"]);

    let blob = alice.send_message(G, "hello bob").unwrap();
    expect_message(bob.process_incoming(&blob).unwrap(), "alice", "hello bob");

    let blob = bob.send_message(G, "hi alice").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "bob", "hi alice");
}

#[test]
fn third_member_join_advances_epoch_for_everyone() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group(G).unwrap();
    let add_bob = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    // alice adds charlie; bob learns about it from the commit.
    let add_charlie = alice.add_member(G, &charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();
    match bob.process_incoming(&add_charlie.commit).unwrap() {
        Event::MembershipChange { epoch, members, .. } => {
            assert_eq!(epoch, 2);
            assert_eq!(members, vec!["alice", "bob", "charlie"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }

    assert_eq!(alice.epoch(G).unwrap(), 2);
    assert_eq!(bob.epoch(G).unwrap(), 2);
    assert_eq!(charlie.epoch(G).unwrap(), 2);

    let blob = bob.send_message(G, "welcome charlie").unwrap();
    expect_message(charlie.process_incoming(&blob).unwrap(), "bob", "welcome charlie");
    let blob = charlie.send_message(G, "glad to be here").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "charlie", "glad to be here");
}

#[test]
fn removal_rotates_epoch_and_locks_out_removed_member() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group(G).unwrap();
    let add_bob = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();
    let add_charlie = alice.add_member(G, &charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();
    bob.process_incoming(&add_charlie.commit).unwrap();

    let remove_commit = alice.remove_member(G, "charlie").unwrap();
    match bob.process_incoming(&remove_commit).unwrap() {
        Event::MembershipChange { epoch, members, .. } => {
            assert_eq!(epoch, 3);
            assert_eq!(members, vec!["alice", "bob"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }

    // Post-removal traffic is unreadable for charlie (he's stuck at epoch 2).
    let blob = alice.send_message(G, "charlie is gone").unwrap();
    assert!(charlie.process_incoming(&blob).is_err());
    expect_message(bob.process_incoming(&blob).unwrap(), "alice", "charlie is gone");
}

#[test]
fn wrong_epoch_message_is_rejected_not_fatal() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group(G).unwrap();
    let add_bob = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    // bob encrypts at epoch 1, but alice advances to epoch 2 before it lands
    // (out-of-order delivery: the commit overtakes the message).
    let stale = bob.send_message(G, "sent at epoch 1").unwrap();
    let add_charlie = alice.add_member(G, &charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();

    // charlie never had epoch-1 keys — the stale message must fail for him.
    assert!(charlie.process_incoming(&stale).is_err());
    // alice still holds epoch-1 secrets and decrypts the late message.
    expect_message(alice.process_incoming(&stale).unwrap(), "bob", "sent at epoch 1");

    // The client survives all of the above and keeps working.
    bob.process_incoming(&add_charlie.commit).unwrap();
    let blob = bob.send_message(G, "still alive").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "bob", "still alive");
}

#[test]
fn multiple_groups_route_by_message_group_id() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();

    alice.create_group("team").unwrap();
    alice.create_group("club").unwrap();
    let add1 = alice.add_member("team", &bob.key_package().unwrap()).unwrap();
    let add2 = alice.add_member("club", &bob.key_package().unwrap()).unwrap();
    assert_eq!(bob.join_from_welcome(&add1.welcome).unwrap(), "team");
    assert_eq!(bob.join_from_welcome(&add2.welcome).unwrap(), "club");
    assert_eq!(bob.group_ids(), vec!["club", "team"]);

    // Messages self-route to the right group state.
    let t = alice.send_message("team", "standup at 9").unwrap();
    let c = alice.send_message("club", "prints due friday").unwrap();
    match bob.process_incoming(&c).unwrap() {
        Event::Message { group, text, .. } => {
            assert_eq!(group, "club");
            assert_eq!(text, "prints due friday");
        }
        other => panic!("expected message, got {other:?}"),
    }
    match bob.process_incoming(&t).unwrap() {
        Event::Message { group, text, .. } => {
            assert_eq!(group, "team");
            assert_eq!(text, "standup at 9");
        }
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn state_snapshot_survives_reload_with_live_ratchets() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();

    alice.create_group(G).unwrap();
    let add = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add.welcome).unwrap();
    let blob = alice.send_message(G, "before reload").unwrap();
    expect_message(bob.process_incoming(&blob).unwrap(), "alice", "before reload");

    // "Reload": drop bob entirely and rebuild from the snapshot.
    let snapshot = bob.export_state().unwrap();
    drop(bob);
    let mut bob = ChatClient::import_state(&snapshot).unwrap();

    assert_eq!(bob.name(), "bob");
    assert_eq!(bob.group_ids(), vec![G]);
    assert_eq!(bob.epoch(G).unwrap(), 1);
    assert_eq!(bob.members(G).unwrap(), vec!["alice", "bob"]);

    // Ratchets must continue exactly where they left off, both directions.
    let blob = alice.send_message(G, "after reload").unwrap();
    expect_message(bob.process_incoming(&blob).unwrap(), "alice", "after reload");
    let blob = bob.send_message(G, "still here").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "bob", "still here");

    // Epoch changes still work post-restore.
    let mut charlie = ChatClient::new("charlie").unwrap();
    let add = alice.add_member(G, &charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add.welcome).unwrap();
    match bob.process_incoming(&add.commit).unwrap() {
        Event::MembershipChange { epoch, .. } => assert_eq!(epoch, 2),
        other => panic!("expected membership change, got {other:?}"),
    }
    let blob = bob.send_message(G, "epoch 2 works").unwrap();
    expect_message(charlie.process_incoming(&blob).unwrap(), "bob", "epoch 2 works");
}

#[test]
fn identity_bundle_restores_account_but_not_groups() {
    let mut alice = ChatClient::new("alice").unwrap();
    alice.create_group(G).unwrap();
    let identity = alice.export_identity().unwrap();
    let pubkey = alice.signature_public_key();
    drop(alice);

    let restored = ChatClient::import_identity(&identity).unwrap();
    assert_eq!(restored.name(), "alice");
    // Same key — the relay's pinned identity still matches…
    assert_eq!(restored.signature_public_key(), pubkey);
    let msg = b"challenge";
    assert!(!restored.sign(msg).unwrap().is_empty());
    // …but group state is intentionally gone (stale ratchets are useless).
    assert!(restored.group_ids().is_empty());

    // The restored identity can be re-added to groups and chat again.
    let mut bob = ChatClient::new("bob").unwrap();
    let mut alice = restored;
    bob.create_group("g2").unwrap();
    let add = bob.add_member("g2", &alice.key_package().unwrap()).unwrap();
    alice.join_from_welcome(&add.welcome).unwrap();
    let blob = alice.send_message("g2", "back from the dead").unwrap();
    expect_message(bob.process_incoming(&blob).unwrap(), "alice", "back from the dead");
}

#[test]
fn external_commit_join_via_group_info() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group(G).unwrap();
    let add = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add.welcome).unwrap();

    // charlie joins with nobody's help: GroupInfo -> external commit.
    let group_info = alice.export_group_info(G).unwrap();
    let (joined, commit) = charlie.join_by_external_commit(&group_info).unwrap();
    assert_eq!(joined, G);
    assert_eq!(charlie.members(G).unwrap(), vec!["alice", "bob", "charlie"]);

    // Existing members merge the commit; the sender IS the new member —
    // that's how the UI knows this was a link join.
    for member in [&mut alice, &mut bob] {
        match member.process_incoming(&commit).unwrap() {
            Event::MembershipChange { epoch, sender, members, .. } => {
                assert_eq!(epoch, 2);
                assert_eq!(sender, "charlie");
                assert_eq!(members, vec!["alice", "bob", "charlie"]);
            }
            other => panic!("expected membership change, got {other:?}"),
        }
    }

    // Traffic flows in every direction afterwards.
    let blob = charlie.send_message(G, "let me introduce myself").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "charlie", "let me introduce myself");
    let blob = bob.send_message(G, "welcome").unwrap();
    expect_message(charlie.process_incoming(&blob).unwrap(), "bob", "welcome");
}

#[test]
fn stale_group_info_external_commit_is_rejected_by_members() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group(G).unwrap();
    let stale_info = alice.export_group_info(G).unwrap(); // epoch 0

    // Group moves on before charlie uses the link.
    let add = alice.add_member(G, &bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add.welcome).unwrap();

    // charlie can still BUILD a commit against the stale info…
    let (_, commit) = charlie.join_by_external_commit(&stale_info).unwrap();
    // …but current members reject it: the epoch has moved on. This is why
    // invite blobs must be refreshed after every epoch change.
    assert!(alice.process_incoming(&commit).is_err());
    charlie.forget_group(G);

    // A fresh GroupInfo works.
    let fresh_info = alice.export_group_info(G).unwrap();
    let (_, commit) = charlie.join_by_external_commit(&fresh_info).unwrap();
    alice.process_incoming(&commit).unwrap();
    let blob = charlie.send_message(G, "second try").unwrap();
    expect_message(alice.process_incoming(&blob).unwrap(), "charlie", "second try");
}
