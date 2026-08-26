// The membership ledger on the wire.
//
// quorum.test.mjs covers the counting rules in isolation. This covers what
// happens when they arrive inside an envelope written by another member's
// client — which is the only way they ever arrive — and the two questions
// that decide whether the mechanism is real: can a member forge somebody
// else's signature, and can one member quietly take a proposal down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminRequirement, applyEnvelope } from '../src/lib/envelope.js';
import { decisionsFor, isCarried, standingSignatures } from '../src/lib/quorum.js';

const NOW = 1_800_000_000_000;

function circle(over = {}) {
  return {
    id: 'srv',
    name: 'Backroom Racing',
    members: ['alice', 'bob', 'dana', 'marek'],
    channels: ['general'],
    voiceChannels: [],
    chanMeta: {},
    roles: { alice: 'admin' },
    proposals: [],
    ...over,
  };
}

const apply = (record, content, { sender = 'marek', isAdmin = false } = {}) =>
  applyEnvelope(record, sender, content, { isAdmin, now: NOW }).effects;

const propose = (record, sender = 'marek', id = 'p1') =>
  apply(record, { k: 'quorum', op: 'propose', p: { id, handle: 'edda', why: 'rides with us', at: NOW } }, { sender });

/* ------------------------------------------------------- the admin gate -- */

test('proposing, signing and objecting are open to every member', () => {
  // The entire point. If any of these needed a role, membership would still
  // be one person's decision with extra steps.
  for (const op of ['propose', 'sign', 'object']) {
    assert.equal(adminRequirement({ k: 'quorum', op }), null, op);
  }
});

test('withdrawing is destructive, and its author may pass', () => {
  assert.deepEqual(adminRequirement({ k: 'quorum', op: 'withdraw' }), {
    destructive: true,
    authorMayPass: true,
  });
  // The number itself is the circle's constitution: an admin changes it.
  assert.deepEqual(adminRequirement({ k: 'threshold', n: 3 }), { destructive: true });
});

/* ------------------------------------------------------------ the wire -- */

test('a proposal off the wire is signed by its sender, not by its payload', () => {
  const record = circle();
  // `by` in the payload says alice; the envelope was written by marek.
  apply(
    record,
    { k: 'quorum', op: 'propose', p: { id: 'p1', handle: 'edda', by: 'alice', at: NOW } },
    { sender: 'marek' },
  );
  assert.equal(record.proposals[0].by, 'marek');
  assert.deepEqual(record.proposals[0].signatures.map((s) => s.who), ['marek']);
});

test('a member cannot sign in somebody else’s name', () => {
  const record = circle();
  propose(record);
  // bob's client posts a signature; the payload has no room to say whose.
  apply(record, { k: 'quorum', op: 'sign', id: 'p1', who: 'dana' }, { sender: 'bob' });
  const who = record.proposals[0].signatures.map((s) => s.who);
  assert.deepEqual(who, ['marek', 'bob']);
});

test('a carried proposal asks exactly one device to run the add', () => {
  const record = circle({ threshold: 3 });
  const first = propose(record);
  assert.ok(first.some((e) => e.t === 'quorumCheck'));
  apply(record, { k: 'quorum', op: 'sign', id: 'p1' }, { sender: 'bob' });
  const effects = apply(record, { k: 'quorum', op: 'sign', id: 'p1' }, { sender: 'dana' });
  assert.ok(effects.some((e) => e.t === 'quorumCheck' && e.id === 'p1'));
  assert.equal(isCarried(record.proposals[0], 3, record.members), true);
});

test('an objection is recorded beside the count, never instead of it', () => {
  const record = circle();
  propose(record);
  apply(record, { k: 'quorum', op: 'sign', id: 'p1' }, { sender: 'bob' });
  apply(record, { k: 'quorum', op: 'object', id: 'p1', why: 'she owes me a wheel' }, { sender: 'dana' });
  assert.equal(standingSignatures(record.proposals[0], record.members).length, 2);
  assert.equal(record.proposals[0].objections[0].who, 'dana');
});

test('only the proposer or an admin takes a proposal down', () => {
  const record = circle();
  propose(record);
  apply(record, { k: 'quorum', op: 'withdraw', id: 'p1' }, { sender: 'bob', isAdmin: false });
  assert.equal(record.proposals.length, 1, 'a bystander cannot');
  apply(record, { k: 'quorum', op: 'withdraw', id: 'p1' }, { sender: 'marek', isAdmin: false });
  assert.equal(record.proposals.length, 0, 'whoever put it forward can');
});

test('changing the threshold says so in the room', () => {
  // §10.7 — a change to who can read this circle is not a silent one.
  const record = circle();
  const effects = apply(record, { k: 'threshold', n: 4 }, { sender: 'alice', isAdmin: true });
  assert.equal(record.threshold, 4);
  const said = effects.find((e) => e.t === 'systemMessage');
  assert.match(said.text, /alice set the signatures a new member needs to 4/);
});

test('a threshold above the roster is clamped rather than locking the circle shut', () => {
  const record = circle();
  apply(record, { k: 'threshold', n: 99 }, { sender: 'alice', isAdmin: true });
  assert.equal(record.threshold, 4, 'the whole circle, and no more');
});

/* ----------------------------------------- the strip on the landing page -- */

test('circles home surfaces only what is still waiting on you', () => {
  const record = circle({ threshold: 3 });
  propose(record);
  const other = circle({ id: 'srv2', name: 'Photo Club', proposals: [] });
  propose(other, 'bob', 'p2');
  const servers = [record, other];

  // marek proposed both, so both already carry his signature.
  assert.deepEqual(decisionsFor(servers, 'marek').map((d) => d.proposal.id), ['p2']);
  const forDana = decisionsFor(servers, 'dana');
  assert.deepEqual(forDana.map((d) => d.proposal.id), ['p1', 'p2']);
  assert.equal(forDana[0].signed, 1);
  assert.equal(forDana[0].threshold, 3);

  // Answering it — either way — takes it off her list.
  apply(record, { k: 'quorum', op: 'object', id: 'p1', why: 'not yet' }, { sender: 'dana' });
  assert.deepEqual(decisionsFor(servers, 'dana').map((d) => d.proposal.id), ['p2']);
});

test('a circle that never chose a threshold still has one', () => {
  // Unset is not "no rule"; it is the majority the circle would have chosen.
  const record = circle();
  propose(record);
  assert.equal(decisionsFor([record], 'dana')[0].threshold, 2);
});
