//! A simulation model of the epoch state machine — Phase 7's "model the epoch
//! state machine" item.
//!
//! §1.1 fixed the unrecoverable group fork: two admins commit at epoch 5, both
//! merge locally, and from then on each other's messages are permanently
//! undecryptable. The fix has three parts — stage don't merge, a relay-side
//! epoch compare-and-swap, and a client that discards and resyncs on rejection.
//! The unit tests cover each part in isolation. What they cannot cover is the
//! part that actually matters: that no *interleaving* of those parts, across
//! several clients acting at once, ever produces two merged views of one epoch.
//!
//! So this file models the protocol instead of testing a call. Each client
//! carries the state a real client carries — the epoch it has merged, its log
//! cursor, and any commit it has staged but not had acked — and a seeded PRNG
//! picks who acts next and what they do. The invariants are checked after
//! every single step, so a violation names the step that caused it rather than
//! the end state.
//!
//! **Why a sequential interleaving is a faithful model.** The relay appends
//! under a per-group send lock (`server.rs`), so every real execution *is*
//! some serial order of these steps. Choosing that order with a PRNG explores
//! the same space the lock permits. The one thing this model cannot check is
//! whether the CAS itself is atomic under genuine parallelism — that has its
//! own test at the bottom, with real threads.
//!
//! The model is deliberately coarser than reality in one way worth stating: it
//! does not run MLS. A "commit" here is an opaque payload, and merging is a
//! counter assignment. That is the right level — the fork is a *serialization*
//! bug, not a cryptographic one, and OpenMLS's own tests cover the ratchet.

use relay::store::{MemoryStore, Store, StoreError};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const GROUP: &str = "circle";

/// xorshift64* — hand-rolled on purpose. A failing seed has to reproduce
/// years from now, which means the generator must be part of this file and
/// not a dependency free to change its stream in a point release.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // Zero is a fixed point of xorshift; the state can never be allowed
        // to reach it, including via the seed.
        let s = seed ^ 0x9e37_79b9_7f4a_7c15;
        Rng(if s == 0 { 1 } else { s })
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// One client's protocol state — exactly the three things §1.1 made it keep.
struct Client {
    name: String,
    /// The highest epoch this client has *merged*. In the real client this is
    /// the MLS group state; merging past what the relay accepted is the fork.
    view: u64,
    /// Last log seq processed.
    cursor: u64,
    /// A commit built for `view + 1` and held un-merged pending the relay's
    /// ack. `None` means nothing outstanding.
    staged: Option<u64>,
}

struct Sim {
    seed: u64,
    store: MemoryStore,
    clients: Vec<Client>,
    rng: Rng,
    /// The ledger of what the relay actually accepted. The store does not
    /// record which entries were commits (`StoredMessage` has no such field —
    /// payloads are opaque to it), so the model keeps that mapping itself:
    /// log seq -> the epoch that commit established.
    commits: HashMap<u64, u64>,
    /// Accepted commit epochs, in acceptance order.
    accepted: Vec<u64>,
    /// Every append the store returned `Ok` for, commit or not.
    appended: u64,
    /// Commits the CAS refused.
    rejected: u64,
    /// One line per step. Only used to prove the run replays from its seed —
    /// without that, a failing seed is not actually reproducible.
    trace: Vec<String>,
}

impl Sim {
    async fn new(seed: u64, members: &[&str]) -> Self {
        let store = MemoryStore::default();
        store.create_group(GROUP, members[0]).await.unwrap();
        for m in &members[1..] {
            store.allow_member(GROUP, *m).await.unwrap();
        }
        Sim {
            seed,
            store,
            clients: members
                .iter()
                .map(|n| Client { name: (*n).to_string(), view: 0, cursor: 0, staged: None })
                .collect(),
            rng: Rng::new(seed),
            commits: HashMap::new(),
            accepted: Vec::new(),
            appended: 0,
            rejected: 0,
            trace: Vec::new(),
        }
    }

    async fn step(&mut self) {
        let i = self.rng.below(self.clients.len());
        let (action, outcome) = match self.rng.below(4) {
            0 => ("stage", self.stage(i)),
            1 => ("commit", self.send_commit(i).await),
            2 => ("catchup", self.catch_up(i).await),
            _ => ("app", self.send_app(i).await),
        };
        let name = self.clients[i].name.clone();
        self.trace.push(format!("{name}/{action}/{outcome}"));
    }

    /// Build a commit for the next epoch and hold it. Nothing is merged here —
    /// that is the whole of "stage, don't merge".
    fn stage(&mut self, i: usize) -> &'static str {
        let c = &mut self.clients[i];
        if c.staged.is_some() {
            return "already";
        }
        c.staged = Some(c.view + 1);
        "staged"
    }

    async fn send_commit(&mut self, i: usize) -> &'static str {
        let Some(epoch) = self.clients[i].staged else {
            return "nothing";
        };
        let name = self.clients[i].name.clone();
        match self.store.append_message(GROUP, epoch, &name, b"commit".to_vec(), true).await {
            Ok(seq) => {
                self.appended += 1;
                self.commits.insert(seq, epoch);
                self.accepted.push(epoch);
                let c = &mut self.clients[i];
                // Merge on ack, never before.
                c.view = epoch;
                c.staged = None;
                "accepted"
            }
            Err(StoreError::EpochConflict) => {
                self.rejected += 1;
                // The protocol's rule on rejection: discard the staged commit.
                // A client that kept it would be holding state for an epoch
                // somebody else now owns — that is the fork, one step early.
                self.clients[i].staged = None;
                "conflict"
            }
            Err(e) => panic!("seed {}: unexpected store error: {e}", self.seed),
        }
    }

    /// Process the log from this client's cursor forward, merging any accepted
    /// commit it has not seen. This is the "process the winning commit" half
    /// of the resync.
    async fn catch_up(&mut self, i: usize) -> &'static str {
        let cursor = self.clients[i].cursor;
        let entries = self.store.messages_after(GROUP, cursor).await.unwrap();
        if entries.is_empty() {
            return "idle";
        }
        let mut replayed = 0u64;
        let mut last = cursor;
        for m in &entries {
            // The log a client replays must have no holes, or its cursor would
            // silently skip an epoch.
            assert_eq!(m.seq, last + 1, "seed {}: log hole at seq {}", self.seed, m.seq);
            last = m.seq;
            if let Some(&e) = self.commits.get(&m.seq) {
                assert_eq!(m.epoch, e, "seed {}: log disagrees with the ledger", self.seed);
                assert!(e > replayed, "seed {}: commits replay out of order", self.seed);
                replayed = e;
            }
        }
        let c = &mut self.clients[i];
        c.cursor = last;
        // `max`, not assignment: a client that has been landing its own
        // commits is already merged past the part of the log it is only now
        // reading back. Its cursor lags; its group state does not.
        c.view = c.view.max(replayed);
        let view = c.view;
        // Anything staged for an epoch the log has already reached is stale
        // intent: drop it and let the client rebuild against the new state.
        if c.staged.is_some_and(|s| s <= view) {
            c.staged = None;
        }
        "merged"
    }

    /// An ordinary message. Not epoch-checked by the relay, so a stale client
    /// can and does stamp an old epoch on one — the model relies on that
    /// happening to check it stays harmless.
    async fn send_app(&mut self, i: usize) -> &'static str {
        let (name, view) = (self.clients[i].name.clone(), self.clients[i].view);
        self.store.append_message(GROUP, view, &name, b"app".to_vec(), false).await.unwrap();
        self.appended += 1;
        "sent"
    }

    /// Drive every client to the head of the log.
    async fn settle(&mut self) {
        for i in 0..self.clients.len() {
            let _ = self.catch_up(i).await;
        }
    }

    /// Invariants cheap enough to check after every step.
    fn check(&self) {
        // One winner per epoch. This *is* the fork property: two accepted
        // commits at one epoch means two divergent group states.
        let mut seen = HashSet::new();
        for e in &self.accepted {
            assert!(seen.insert(*e), "seed {}: epoch {e} was accepted twice", self.seed);
        }
        // Accepted commits form a contiguous chain from 1, in order. Stated
        // separately from uniqueness because a gap and a duplicate are
        // different bugs and deserve different failure messages.
        for (n, e) in self.accepted.iter().enumerate() {
            assert_eq!(
                *e,
                n as u64 + 1,
                "seed {}: accepted epochs are not a chain: {:?}",
                self.seed,
                self.accepted
            );
        }
        let head = self.accepted.len() as u64;
        for c in &self.clients {
            // The headline invariant. A client whose merged epoch runs ahead
            // of what the relay accepted has forked, by definition — this is
            // the assertion that would have failed before §1.1.
            assert!(
                c.view <= head,
                "seed {}: {} merged epoch {} but only {head} commits were accepted",
                self.seed,
                c.name,
                c.view,
            );
            // Staged intent always targets the future, never the merged past.
            assert!(
                c.staged.is_none_or(|s| s > c.view),
                "seed {}: {} holds a commit for {:?} at view {}",
                self.seed,
                c.name,
                c.staged,
                c.view,
            );
        }
    }

    /// Invariants that need to read the whole log back.
    async fn check_log(&self) {
        let log = self.store.messages_after(GROUP, 0).await.unwrap();
        assert_eq!(
            log.len() as u64,
            self.appended,
            "seed {}: {} rejected commit(s) left entries behind",
            self.seed,
            self.rejected,
        );
        let mut chain = 0u64;
        for (n, m) in log.iter().enumerate() {
            assert_eq!(m.seq, n as u64 + 1, "seed {}: seq is not dense and 1-based", self.seed);
            match self.commits.get(&m.seq) {
                Some(&e) => {
                    assert_eq!(m.epoch, e, "seed {}: stored epoch != accepted epoch", self.seed);
                    assert_eq!(e, chain + 1, "seed {}: commits in the log skip an epoch", self.seed);
                    chain = e;
                }
                // An application message may carry a *stale* epoch — that is
                // expected and unchecked by the relay. What it must never do
                // is carry one the log has not reached, which would mean its
                // sender merged something nobody accepted.
                None => assert!(
                    m.epoch <= chain,
                    "seed {}: {} sent at epoch {} with the log at {chain}",
                    self.seed,
                    m.sender,
                    m.epoch,
                ),
            }
        }
        assert_eq!(chain, self.accepted.len() as u64);
    }

    /// The store keeps its epoch privately, so read it the only way a client
    /// can: by finding out which commit it will accept. Exactly one value
    /// works, and it is the number of commits the model saw accepted.
    async fn probe(&mut self) {
        let head = self.accepted.len() as u64;
        for e in [0, head, head + 2, head + 7] {
            let r = self.store.append_message(GROUP, e, "probe", b"c".to_vec(), true).await;
            assert!(
                matches!(r, Err(StoreError::EpochConflict)),
                "seed {}: a commit at epoch {e} should have been refused with the log at {head}",
                self.seed,
            );
        }
        self.store
            .append_message(GROUP, head + 1, "probe", b"c".to_vec(), true)
            .await
            .unwrap_or_else(|e| panic!("seed {}: commit at {} refused: {e}", self.seed, head + 1));
    }
}

#[tokio::test]
async fn the_epoch_state_machine_never_forks() {
    let mut total_accepted = 0u64;
    let mut total_rejected = 0u64;

    for seed in 0..64u64 {
        let mut sim = Sim::new(seed, &["alice", "bob", "carol", "dave"]).await;
        for _ in 0..200 {
            sim.step().await;
            sim.check();
        }
        sim.settle().await;
        sim.check();
        sim.check_log().await;

        // Convergence: after everyone has replayed the log, there is one
        // group state, not several. No message loss either — check_log has
        // just proved the log is dense and every append is still in it.
        let head = sim.accepted.len() as u64;
        for c in &sim.clients {
            assert_eq!(
                c.view, head,
                "seed {seed}: {} settled at {} but the log head is {head}",
                c.name, c.view,
            );
        }
        sim.probe().await;

        total_accepted += head;
        total_rejected += sim.rejected;
    }

    // A green run means nothing if the sweep never actually raced anybody, so
    // assert it did. The thresholds are far below what 64 runs of 200 steps
    // produce; they exist to catch the model going inert, not to measure it.
    assert!(total_accepted > 100, "the sweep accepted only {total_accepted} commits — not an exercise");
    assert!(
        total_rejected > 10,
        "the sweep hit only {total_rejected} epoch conflicts — it is not testing what it claims",
    );
}

#[tokio::test]
async fn the_simulation_replays_from_its_seed() {
    async fn run(seed: u64) -> Vec<String> {
        let mut sim = Sim::new(seed, &["alice", "bob", "carol"]).await;
        for _ in 0..200 {
            sim.step().await;
        }
        sim.trace
    }
    // Without this, a seed printed in a CI failure is not enough to reproduce
    // it, and the whole harness is a lottery rather than a test.
    assert_eq!(run(7).await, run(7).await, "one seed must replay identically");
    assert_ne!(run(7).await, run(8).await, "different seeds must explore different orders");
}

/// The §1.1 "done when" clause, written out rather than sampled: two admins
/// commit at the same epoch, and both end up on the same epoch with nothing
/// lost.
#[tokio::test]
async fn two_admins_committing_at_one_epoch_converge_with_no_message_loss() {
    let mut sim = Sim::new(0, &["alice", "bob"]).await;

    // Both build a commit for epoch 1 from the same starting view.
    sim.stage(0);
    sim.stage(1);
    assert_eq!(sim.clients[0].staged, Some(1));
    assert_eq!(sim.clients[1].staged, Some(1));

    // Alice's lands. Bob's is refused — and, critically, bob has not merged.
    // Pre-1.1 both would be at epoch 1 with different group states here.
    assert_eq!(sim.send_commit(0).await, "accepted");
    assert_eq!(sim.send_commit(1).await, "conflict");
    assert_eq!(sim.accepted, vec![1]);
    assert_eq!(sim.clients[1].view, 0, "the loser must not have merged");
    assert_eq!(sim.clients[1].staged, None, "the loser must have discarded its commit");

    // Bob sends an ordinary message before resyncing: it is accepted, at his
    // stale epoch, and does not disturb the chain.
    sim.send_app(1).await;

    // Resync, rebuild intent, retry — and now it lands, as epoch 2.
    assert_eq!(sim.catch_up(1).await, "merged");
    assert_eq!(sim.clients[1].view, 1);
    sim.stage(1);
    assert_eq!(sim.send_commit(1).await, "accepted");
    assert_eq!(sim.accepted, vec![1, 2]);

    sim.settle().await;
    sim.check();
    sim.check_log().await;
    assert_eq!(sim.clients[0].view, 2);
    assert_eq!(sim.clients[1].view, 2, "both admins converge on one epoch");
    // Three appends made, three still in the log: the loser's message was not
    // collateral damage of the rejected commit.
    assert_eq!(sim.appended, 3);
}

/// The regression test for the pre-§1.1 client, which merged locally and kept
/// going. Model that as a client that never discards its staged commit.
#[tokio::test]
async fn a_client_that_never_resyncs_can_never_land_a_stale_commit() {
    let store = MemoryStore::default();
    store.create_group(GROUP, "alice").await.unwrap();
    store.append_message(GROUP, 1, "alice", b"c".to_vec(), true).await.unwrap();

    for _ in 0..16 {
        let r = store.append_message(GROUP, 1, "bob", b"c".to_vec(), true).await;
        assert!(matches!(r, Err(StoreError::EpochConflict)), "a stale commit must never land");
    }
    assert_eq!(
        store.messages_after(GROUP, 0).await.unwrap().len(),
        1,
        "sixteen refused commits left nothing behind",
    );

    // Only after resyncing to epoch 1 does bob's next commit go through.
    let seq = store.append_message(GROUP, 2, "bob", b"c".to_vec(), true).await.unwrap();
    assert_eq!(seq, 2);
}

/// The one property the sequential model cannot reach: that the CAS is atomic
/// under genuine parallelism. If `append_message` read the epoch and wrote it
/// back non-atomically, this is the test that catches it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_commits_at_one_epoch_have_exactly_one_winner() {
    const RACERS: usize = 32;

    let store = Arc::new(MemoryStore::default());
    store.create_group(GROUP, "alice").await.unwrap();

    let mut tasks = Vec::new();
    for i in 0..RACERS {
        let s = store.clone();
        tasks.push(tokio::spawn(async move {
            let who = format!("client-{i}");
            s.append_message(GROUP, 1, &who, b"c".to_vec(), true).await
        }));
    }

    let mut won = 0usize;
    let mut lost = 0usize;
    for t in tasks {
        match t.await.unwrap() {
            Ok(_) => won += 1,
            Err(StoreError::EpochConflict) => lost += 1,
            Err(e) => panic!("unexpected store error: {e}"),
        }
    }
    assert_eq!(won, 1, "{RACERS} racers at one epoch, and {won} of them won");
    assert_eq!(lost, RACERS - 1);
    assert_eq!(
        store.messages_after(GROUP, 0).await.unwrap().len(),
        1,
        "the losers left no trace in the log",
    );
}
