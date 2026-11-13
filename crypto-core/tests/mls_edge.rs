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
    assert!(alice.add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key()).is_err());
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
    let add = alice.add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key()).unwrap();
    alice.merge_staged_commit(G).unwrap();

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
    let add_bob = alice.add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key()).unwrap();
    alice.merge_staged_commit(G).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();

    let stale = bob.send_message(G, "epoch 1").unwrap();
    let add_charlie = alice.add_member(G, &charlie.key_package().unwrap(), "charlie", &charlie.signature_public_key()).unwrap();
    alice.merge_staged_commit(G).unwrap();
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

// --- KeyPackage identity binding -----------------------------------------
// The relay is what serves KeyPackages, and `KeyPackageIn::validate` only
// checks a KeyPackage against itself — it happily validates one minted by
// anybody. These pin down that the adder binds the KeyPackage to the handle
// and pinned key it asked for, so a relay cannot answer "give me bob's
// KeyPackage" with one that makes the relay a member reading everything.

#[test]
fn a_key_package_naming_someone_else_is_refused() {
    let mut alice = ChatClient::new("alice").unwrap();
    let bob = ChatClient::new("bob").unwrap();
    let charlie = ChatClient::new("charlie").unwrap();
    alice.create_group(G).unwrap();

    // alice asked for bob; the relay answered with charlie's KeyPackage.
    // AddResult deliberately has no Debug (it carries commit/welcome bytes),
    // so unwrap the error by hand rather than via expect_err.
    let err = match alice.add_member(G, &charlie.key_package().unwrap(), "bob", &bob.signature_public_key()) {
        Ok(_) => panic!("a credential naming charlie must not be admitted as bob"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("identity mismatch"),
        "expected an identity mismatch, got: {err}"
    );
    assert_eq!(alice.epoch(G).unwrap(), 0, "the group must not have advanced");
    assert_eq!(alice.members(G).unwrap(), vec!["alice"], "and nobody was added");
}

#[test]
fn a_substituted_key_under_the_right_name_is_refused() {
    // The real attack: the relay mints its own KeyPackage bearing
    // BasicCredential("bob") — the identity matches, so only the pinned
    // signature key distinguishes it from the genuine article.
    let mut alice = ChatClient::new("alice").unwrap();
    let real_bob = ChatClient::new("bob").unwrap();
    let impostor = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();

    assert_ne!(
        real_bob.signature_public_key(),
        impostor.signature_public_key(),
        "the impostor is a different keypair under the same handle"
    );

    let err = match alice.add_member(G, &impostor.key_package().unwrap(), "bob", &real_bob.signature_public_key()) {
        Ok(_) => panic!("a KeyPackage under bob's name but another key must be refused"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("unexpected signature key"),
        "expected a key mismatch, got: {err}"
    );
    assert_eq!(alice.epoch(G).unwrap(), 0, "the group must not have advanced");
    assert_eq!(alice.members(G).unwrap(), vec!["alice"], "and the impostor is not a member");
}

#[test]
fn the_genuine_key_package_still_admits_the_member() {
    // Positive control: the checks must not break the ordinary path.
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();

    let add = match alice.add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key()) {
        Ok(a) => a,
        Err(e) => panic!("the real bob is still addable, got: {e}"),
    };
    alice.merge_staged_commit(G).unwrap();
    bob.join_from_welcome(&add.welcome).unwrap();
    assert_eq!(alice.members(G).unwrap(), vec!["alice", "bob"]);
    assert_eq!(bob.members(G).unwrap(), vec!["alice", "bob"]);
}

// --- staged commits ------------------------------------------------------
// Commits used to merge the instant they were built, before the relay had
// accepted them, so two admins committing in the same second each held a
// different epoch N+1 and could never decrypt the other again. Staging makes
// the relay's ordered log the serializer.

#[test]
fn a_staged_commit_does_not_advance_the_group_until_merged() {
    let mut alice = ChatClient::new("alice").unwrap();
    let bob = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();

    let _ = alice
        .add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key())
        .unwrap();
    assert_eq!(alice.epoch(G).unwrap(), 0, "staging must not move the epoch");
    assert_eq!(alice.members(G).unwrap(), vec!["alice"], "nor the roster");

    assert_eq!(alice.merge_staged_commit(G).unwrap(), 1);
    assert_eq!(alice.epoch(G).unwrap(), 1);
    assert_eq!(alice.members(G).unwrap(), vec!["alice", "bob"]);
}

#[test]
fn discarding_a_staged_commit_leaves_the_loser_able_to_process_the_winner() {
    // The fork scenario, end to end. alice and bob are both members at epoch
    // 1 and both commit against it. alice's commit reaches the log first; bob
    // must be able to drop his and follow hers rather than diverging.
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    let charlie = ChatClient::new("charlie").unwrap();
    let dave = ChatClient::new("dave").unwrap();
    alice.create_group(G).unwrap();

    let add_bob = alice
        .add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key())
        .unwrap();
    alice.merge_staged_commit(G).unwrap();
    bob.join_from_welcome(&add_bob.welcome).unwrap();
    assert_eq!(alice.epoch(G).unwrap(), 1);
    assert_eq!(bob.epoch(G).unwrap(), 1);

    // Both stage a commit against epoch 1, in the same instant.
    let alice_add = alice
        .add_member(G, &charlie.key_package().unwrap(), "charlie", &charlie.signature_public_key())
        .unwrap();
    let _bob_add = bob
        .add_member(G, &dave.key_package().unwrap(), "dave", &dave.signature_public_key())
        .unwrap();

    // alice's reaches the relay first and is accepted; she merges.
    alice.merge_staged_commit(G).unwrap();

    // bob's is refused, so he drops it and stays at epoch 1 — which is what
    // lets him process the commit that did win.
    bob.discard_staged_commit(G).unwrap();
    assert_eq!(bob.epoch(G).unwrap(), 1, "bob did not move");
    bob.process_incoming(&alice_add.commit).unwrap();

    assert_eq!(bob.epoch(G).unwrap(), alice.epoch(G).unwrap(), "converged on one epoch");
    assert_eq!(bob.members(G).unwrap(), alice.members(G).unwrap(), "and one roster");

    // And they can still talk — the thing the fork used to destroy.
    let blob = alice.send_message(G, "still here").unwrap();
    expect_message_edge(bob.process_incoming(&blob).unwrap(), "alice", "still here");
}

fn expect_message_edge(event: Event, sender: &str, text: &str) {
    match event {
        Event::Message { sender: s, text: t, .. } => {
            assert_eq!(s, sender);
            assert_eq!(t, text);
        }
        other => panic!("expected message, got {other:?}"),
    }
}

// --- one name, one key ----------------------------------------------------
//
// A basic credential is a self-asserted string. These pin the rule that a
// commit may not put a name in the group under a key other than the one a
// current member already holds for it — on every path a leaf can arrive by.

/// alice creates the group and adds bob; both are at the same epoch.
fn pair() -> (ChatClient, ChatClient) {
    let mut alice = ChatClient::new("alice").unwrap();
    let mut bob = ChatClient::new("bob").unwrap();
    alice.create_group(G).unwrap();
    let add = alice
        .add_member(G, &bob.key_package().unwrap(), "bob", &bob.signature_public_key())
        .unwrap();
    alice.merge_staged_commit(G).unwrap();
    bob.join_from_welcome(&add.welcome).unwrap();
    (alice, bob)
}

#[test]
fn a_link_joiner_cannot_take_an_existing_members_name() {
    let (mut alice, mut bob) = pair();
    // Somebody else entirely, calling themselves alice.
    let mut mallory = ChatClient::new("alice").unwrap();
    assert_ne!(alice.signature_public_key(), mallory.signature_public_key());

    let info = alice.export_group_info(G).unwrap();
    let (_, commit) = mallory.join_by_external_commit(&info).unwrap();

    let epoch = bob.epoch(G).unwrap();
    let err = bob.process_incoming(&commit).unwrap_err();
    assert!(
        err.to_string().starts_with("identity conflict: alice"),
        "the refusal names who was being impersonated: {err}"
    );
    // Refused before the merge: nothing about bob's group moved.
    assert_eq!(bob.epoch(G).unwrap(), epoch);
    assert_eq!(bob.members(G).unwrap(), vec!["alice", "bob"]);
    let keys = bob.member_keys(G).unwrap();
    assert_eq!(keys.len(), 2);
    assert!(keys.iter().any(|(n, k)| n == "alice" && *k == alice.signature_public_key()));

    // And the real alice is still who bob hears.
    let blob = alice.send_message(G, "still me").unwrap();
    match bob.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!((sender.as_str(), text.as_str()), ("alice", "still me"));
        }
        other => panic!("expected a message, got {other:?}"),
    }
    // Nothing the impostor sends from their own branch is readable.
    let forged = mallory.send_message(G, "it's me, alice").unwrap();
    assert!(bob.process_incoming(&forged).is_err());
}

#[test]
fn an_admin_cannot_add_a_second_key_under_a_members_name() {
    // The adder's own check compares the KeyPackage with what the relay
    // pinned — so a hostile relay, or a modified client, gets past it. Every
    // other member has to refuse the commit independently.
    let (mut alice, mut bob) = pair();
    let mut carol = ChatClient::new("carol").unwrap();
    let add = alice
        .add_member(G, &carol.key_package().unwrap(), "carol", &carol.signature_public_key())
        .unwrap();
    alice.merge_staged_commit(G).unwrap();
    bob.process_incoming(&add.commit).unwrap();
    carol.join_from_welcome(&add.welcome).unwrap();

    let fake_bob = ChatClient::new("bob").unwrap();
    let add = alice
        .add_member(G, &fake_bob.key_package().unwrap(), "bob", &fake_bob.signature_public_key())
        .unwrap();
    let err = carol.process_incoming(&add.commit).unwrap_err();
    assert!(err.to_string().starts_with("identity conflict: bob"), "{err}");
    assert_eq!(carol.members(G).unwrap(), vec!["alice", "bob", "carol"]);
}

#[test]
fn the_same_identity_joining_again_replaces_its_old_device() {
    // Same name AND same key: one person, opening an invite link on a second
    // device. It is not a conflict — but it is not a second seat either. MLS
    // resyncs: the new leaf replaces the old one, and the old device is out.
    let (mut alice, mut bob) = pair();
    let mut bobs_phone = ChatClient::import_identity(&bob.export_identity().unwrap()).unwrap();
    assert_eq!(bob.signature_public_key(), bobs_phone.signature_public_key());

    let info = alice.export_group_info(G).unwrap();
    let (_, commit) = bobs_phone.join_by_external_commit(&info).unwrap();

    match alice.process_incoming(&commit).unwrap() {
        Event::MembershipChange { members, active, .. } => {
            assert_eq!(members, vec!["alice", "bob"], "one bob, not two");
            assert!(active, "alice is untouched");
        }
        other => panic!("expected a membership change, got {other:?}"),
    }
    // The old device is told, in so many words, that it is no longer in —
    // its name is still in the roster, so nothing else would say so.
    match bob.process_incoming(&commit).unwrap() {
        Event::MembershipChange { members, active, .. } => {
            assert!(members.contains(&"bob".to_string()));
            assert!(!active, "the laptop's leaf was replaced by the phone's");
        }
        other => panic!("expected a membership change, got {other:?}"),
    }

    let blob = bobs_phone.send_message(G, "from the phone").unwrap();
    match alice.process_incoming(&blob).unwrap() {
        Event::Message { sender, text, .. } => {
            assert_eq!((sender.as_str(), text.as_str()), ("bob", "from the phone"));
        }
        other => panic!("expected a message, got {other:?}"),
    }
    assert!(bob.process_incoming(&blob).is_err(), "the replaced device can no longer read");
    assert!(bob.send_message(G, "from the laptop").is_err(), "or send");
}
