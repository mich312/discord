//! Persisted-state compatibility across OpenMLS upgrades.
//!
//! `fixtures/openmls-0.7.4/` was written by this crate when it was built on
//! OpenMLS 0.7.4 / openmls_rust_crypto 0.4.4: three `export_state` blobs as
//! IndexedDB holds them, a recovery-key identity bundle, and wire blobs that
//! were still in flight at export time. The identities are throwaway test
//! keys. Scenario (all under 0.7.4):
//!
//!   alice creates the group and adds bob (epoch 1); they trade messages;
//!   bob sends `past-epoch.msg`, which alice has not received; alice adds a
//!   placeholder member "dave" (epoch 2, bob follows); alice sends
//!   `in-flight.msg`, which bob has not received; carol publishes a
//!   KeyPackage (its private half stays in carol.state) and alice STAGES —
//!   does not merge — the commit adding her (`add-carol.*`). Then every state
//!   is exported.
//!
//! OpenMLS 0.8 changed some serde tags of its storage types; 0.9.0 restored
//! the 0.7 encoding by default (openmls#2034), keeping 0.8's behind the
//! `0-8-1-storage-format` feature, which this crate must not enable. If a
//! future upgrade can no longer read what browsers have stored, this fails
//! here instead of silently dropping users out of every group. Do not
//! regenerate the fixtures to make it pass.

use crypto_core::{ChatClient, Event};

const G: &str = "grp-compat";

fn fx(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/openmls-0.7.4/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn text(event: Event) -> (String, String) {
    match event {
        Event::Message { sender, text, .. } => (sender, text),
        other => panic!("expected message, got {other:?}"),
    }
}

#[test]
fn state_written_by_openmls_0_7_loads_and_keeps_working() {
    let mut alice = ChatClient::import_state(&fx("alice.state")).expect("alice 0.7 state");
    let mut bob = ChatClient::import_state(&fx("bob.state")).expect("bob 0.7 state");
    let mut carol = ChatClient::import_state(&fx("carol.state")).expect("carol 0.7 state");

    // Identity and group membership survive unchanged.
    assert_eq!(alice.signature_public_key(), fx("alice.pk"));
    assert_eq!(alice.epoch(G).unwrap(), 2);
    assert_eq!(alice.members(G).unwrap(), ["alice", "bob", "dave"]);
    assert_eq!(
        alice.safety_number(G, "bob").unwrap().as_bytes(),
        fx("alice-bob.sn").as_slice()
    );
    let restored = ChatClient::import_identity(&fx("alice.ident")).expect("0.7 identity bundle");
    assert_eq!(restored.signature_public_key(), fx("alice.pk"));

    // Ratchets persisted by 0.7: current epoch, and a past epoch's secrets.
    assert_eq!(
        text(bob.process_incoming(&fx("in-flight.msg")).unwrap()),
        ("alice".into(), "in flight across the upgrade".into())
    );
    assert_eq!(
        text(alice.process_incoming(&fx("past-epoch.msg")).unwrap()),
        ("bob".into(), "sent at epoch 1".into())
    );

    // A commit staged under 0.7 merges under 0.9, and its 0.7-built Welcome
    // is opened with the KeyPackage private key 0.7 stored for carol.
    assert_eq!(alice.merge_staged_commit(G).unwrap(), 3);
    match bob.process_incoming(&fx("add-carol.commit")).unwrap() {
        Event::MembershipChange { epoch, members, .. } => {
            assert_eq!(epoch, 3);
            assert_eq!(members, ["alice", "bob", "dave", "carol"]);
        }
        other => panic!("expected membership change, got {other:?}"),
    }
    assert_eq!(carol.join_from_welcome(&fx("add-carol.welcome")).unwrap(), G);

    let blob = carol.send_message(G, "hi from carol").unwrap();
    assert_eq!(text(alice.process_incoming(&blob).unwrap()).1, "hi from carol");
    assert_eq!(text(bob.process_incoming(&blob).unwrap()).1, "hi from carol");

    // And the migrated state round-trips through the current export.
    let mut bob = ChatClient::import_state(&bob.export_state().unwrap()).unwrap();
    let blob = alice.send_message(G, "after round-trip").unwrap();
    assert_eq!(text(bob.process_incoming(&blob).unwrap()).1, "after round-trip");
}
