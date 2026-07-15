//! Native integration tests for the MLS core: everything that must work
//! before the browser is involved. All inter-client traffic goes through
//! serialized byte blobs, exactly as it will over the relay.

use crypto_core::{ChatClient, Event};

#[test]
fn two_party_create_join_exchange() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();

    alice.create_group().unwrap();
    assert_eq!(alice.epoch().unwrap(), 0);

    // bob publishes a KeyPackage; alice adds him.
    let bob_kp = bob.key_package().unwrap();
    let add = alice.add_member(&bob_kp).unwrap();
    assert_eq!(alice.epoch().unwrap(), 1);

    // bob joins from the Welcome.
    bob.join_from_welcome(&add.welcome).unwrap();
    assert_eq!(bob.epoch().unwrap(), 1);
    assert_eq!(bob.members().unwrap(), vec!["alice", "bob"]);
    assert_eq!(alice.members().unwrap(), vec!["alice", "bob"]);

    // alice -> bob
    let blob = alice.send_message("hello bob").unwrap();
    match bob.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!(sender, "alice");
            assert_eq!(text, "hello bob");
        }
        other => panic!("expected message, got {other:?}"),
    }

    // bob -> alice
    let blob = bob.send_message("hi alice").unwrap();
    match alice.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!(sender, "bob");
            assert_eq!(text, "hi alice");
        }
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn third_member_join_advances_epoch_for_everyone() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group().unwrap();
    let add_bob = alice.add_member(&bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    // alice adds charlie; bob learns about it from the commit.
    let add_charlie = alice.add_member(&charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();
    match bob.process_incoming(&add_charlie.commit).unwrap() {
        Event::MembershipChange { epoch, members } => {
            assert_eq!(epoch, 2);
            assert_eq!(members, vec!["alice", "bob", "charlie"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }

    assert_eq!(alice.epoch().unwrap(), 2);
    assert_eq!(bob.epoch().unwrap(), 2);
    assert_eq!(charlie.epoch().unwrap(), 2);

    // charlie can read messages sent after his join…
    let blob = bob.send_message("welcome charlie").unwrap();
    match charlie.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!(sender, "bob");
            assert_eq!(text, "welcome charlie");
        }
        other => panic!("expected message, got {other:?}"),
    }
    // …and alice reads the same blob-shape traffic too.
    let blob = charlie.send_message("glad to be here").unwrap();
    match alice.process_incoming(&blob).unwrap() {
        Event::Message { sender, .. } => assert_eq!(sender, "charlie"),
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn removal_rotates_epoch_and_locks_out_removed_member() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group().unwrap();
    let add_bob = alice.add_member(&bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();
    let add_charlie = alice.add_member(&charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();
    bob.process_incoming(&add_charlie.commit).unwrap();

    // alice kicks charlie; bob merges the commit.
    let remove_commit = alice.remove_member("charlie").unwrap();
    match bob.process_incoming(&remove_commit).unwrap() {
        Event::MembershipChange { epoch, members } => {
            assert_eq!(epoch, 3);
            assert_eq!(members, vec!["alice", "bob"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }

    // Post-removal traffic is unreadable for charlie (he's stuck at epoch 2).
    let blob = alice.send_message("charlie is gone").unwrap();
    assert!(charlie.process_incoming(&blob).is_err());

    // But bob reads it fine.
    match bob.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!(sender, "alice");
            assert_eq!(text, "charlie is gone");
        }
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn wrong_epoch_message_is_rejected_not_fatal() {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let mut charlie = ChatClient::new("charlie").unwrap();

    alice.create_group().unwrap();
    let add_bob = alice.add_member(&bob.key_package().unwrap()).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    // bob encrypts at epoch 1, but alice advances to epoch 2 before it lands
    // (out-of-order delivery: the commit overtakes the message).
    let stale = bob.send_message("sent at epoch 1").unwrap();
    let add_charlie = alice.add_member(&charlie.key_package().unwrap()).unwrap();
    charlie.join_from_welcome(&add_charlie.welcome).unwrap();

    // charlie never had epoch-1 keys — the stale message must fail for him.
    assert!(charlie.process_incoming(&stale).is_err());

    // alice still holds epoch-1 secrets and decrypts the late message.
    match alice.process_incoming(&stale).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!(sender, "bob");
            assert_eq!(text, "sent at epoch 1");
        }
        other => panic!("expected message, got {other:?}"),
    }

    // The client survives all of the above and keeps working.
    bob.process_incoming(&add_charlie.commit).unwrap();
    let blob = bob.send_message("still alive").unwrap();
    match alice.process_incoming(&blob).unwrap() {
        Event::Message { text, .. } => assert_eq!(text, "still alive"),
        other => panic!("expected message, got {other:?}"),
    }
}
