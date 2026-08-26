// Nobody adds a member alone.
//
// This is the one irreversible thing in the product — everyone admitted can
// read everything the room keys unlock, back to the first message anyone
// sent — so the interesting cases are the ones where somebody tries to make
// the count say something it should not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSALS_MAX,
  WHY_MAX,
  admitter,
  applyObjection,
  applySignature,
  awaitingFrom,
  canWithdraw,
  defaultThreshold,
  isCarried,
  mergeProposals,
  normalizeProposal,
  normalizeProposals,
  normalizeThreshold,
  standingSignatures,
  upsertProposal,
} from '../src/lib/quorum.js';

const NOW = 1_700_000_000_000;
const CIRCLE = ['alice', 'bob', 'dana', 'marek', 'charlie', 'edda'];
const proposal = (over = {}) =>
  normalizeProposal({ id: 'p1', handle: 'nadia', why: 'rides with the Otley lot', at: NOW, ...over }, 'marek', NOW);

test('a threshold of one is the feature switched off, not a lower setting', () => {
  // One person letting somebody in is exactly what this exists to prevent.
  assert.equal(normalizeThreshold(1, 6), 2);
  assert.equal(normalizeThreshold(0, 6), 2);
  assert.equal(normalizeThreshold(-5, 6), 2);
  // …except in a circle of one, where there is nobody else to ask.
  assert.equal(normalizeThreshold(1, 1), 1);
  assert.equal(defaultThreshold(1), 1);
});

test('a threshold above the roster would lock the circle shut', () => {
  assert.equal(normalizeThreshold(99, 6), 6);
  assert.equal(normalizeThreshold(6, 6), 6, 'unanimity is a legitimate choice');
  // Not a number at all — including the infinities — is nonsense rather than
  // a very large setting, so it falls back to what the circle would have got
  // if it had never chosen.
  assert.equal(normalizeThreshold(Infinity, 6), defaultThreshold(6));
  assert.equal(normalizeThreshold('nonsense', 6), defaultThreshold(6));
});

test('the default is a majority', () => {
  assert.equal(defaultThreshold(2), 2);
  assert.equal(defaultThreshold(3), 2);
  assert.equal(defaultThreshold(6), 3);
  assert.equal(defaultThreshold(7), 4);
});

test('the proposer is the sender, and proposing counts as signing', () => {
  // You do not put a name forward and then abstain on it. And a member who
  // could name somebody else as the proposer could launder a proposal.
  const p = normalizeProposal({ id: 'p1', handle: 'nadia', by: 'alice', at: NOW }, 'marek', NOW);
  assert.equal(p.by, 'marek');
  assert.deepEqual(p.signatures, [{ who: 'marek', at: NOW }]);
});

test('a proposal with nobody in it is not a proposal', () => {
  assert.equal(normalizeProposal({ id: 'p1', at: NOW }, 'marek', NOW), null);
  assert.equal(normalizeProposal({ handle: 'nadia', at: NOW }, 'marek', NOW), null);
  assert.equal(normalizeProposal({ id: 'p1', handle: 'nadia', at: NOW }, '', NOW), null);
});

test('signing twice is one signature', () => {
  let list = [proposal()];
  list = applySignature(list, 'p1', 'bob', NOW + 1);
  list = applySignature(list, 'p1', 'bob', NOW + 2);
  assert.equal(list[0].signatures.length, 2, 'marek and bob');
});

test('an objection does not cancel the count, and it needs a reason', () => {
  // "I think this is a bad idea" and "this may not proceed" are different
  // claims, and only the first is one member's to make.
  let list = [proposal()];
  list = applySignature(list, 'p1', 'bob', NOW + 1);
  list = applySignature(list, 'p1', 'dana', NOW + 2);
  list = applyObjection(list, 'p1', 'charlie', 'she owes me a wheel', NOW + 3);
  assert.equal(standingSignatures(list[0], CIRCLE).length, 3);
  assert.equal(list[0].objections.length, 1);
  assert.equal(isCarried(list[0], 3, CIRCLE), true, 'an objection is not a veto');
  // A bare objection is not one.
  const before = list[0].objections.length;
  list = applyObjection(list, 'p1', 'edda', '   ', NOW + 4);
  assert.equal(list[0].objections.length, before);
});

test('changing your mind moves your name, it does not add a second', () => {
  let list = [proposal()];
  list = applySignature(list, 'p1', 'bob', NOW + 1);
  list = applyObjection(list, 'p1', 'bob', 'thought about it', NOW + 2);
  assert.equal(list[0].signatures.some((s) => s.who === 'bob'), false);
  assert.equal(list[0].objections.filter((o) => o.who === 'bob').length, 1);
  list = applySignature(list, 'p1', 'bob', NOW + 3);
  assert.equal(list[0].objections.some((o) => o.who === 'bob'), false);
  assert.equal(list[0].signatures.filter((s) => s.who === 'bob').length, 1);
});

test('a member who has left stops propping up the count', () => {
  let list = [proposal()];
  list = applySignature(list, 'p1', 'bob', NOW + 1);
  list = applySignature(list, 'p1', 'dana', NOW + 2);
  assert.equal(isCarried(list[0], 3, CIRCLE), true);
  const smaller = ['alice', 'marek', 'bob'];
  assert.equal(standingSignatures(list[0], smaller).length, 2);
  assert.equal(isCarried(list[0], 3, smaller), false, 'dana left; her signature left with her');
});

test('a rebroadcast cannot quietly drop the proposer from the count', () => {
  // 3-of-4 turning into 2-of-4 because a snapshot forgot the implied
  // signature would let a proposal that had carried un-carry itself.
  const wire = [{ ...proposal(), signatures: [{ who: 'bob', at: NOW }, { who: 'dana', at: NOW }] }];
  const [p] = normalizeProposals(wire, NOW);
  assert.equal(p.signatures.length, 3);
  assert.ok(p.signatures.some((s) => s.who === 'marek'));
});

test('a whole list off the wire is bounded and cleaned', () => {
  const wire = [
    { id: 'a', handle: 'nadia', by: 'marek', at: NOW, why: 'x'.repeat(5000), signatures: [{ who: '' }], objections: [{ who: 'bob', why: '' }] },
    { id: 'b', handle: '', by: 'marek', at: NOW },
  ];
  const out = normalizeProposals(wire, NOW);
  assert.equal(out.length, 1, 'the one with nobody in it is dropped');
  assert.equal(out[0].why.length, WHY_MAX);
  assert.deepEqual(out[0].signatures, [{ who: 'marek', at: NOW }], 'the nameless signature is dropped');
  assert.deepEqual(out[0].objections, [], 'an objection with no reason is not an objection');
});

test('the ledger is capped', () => {
  let list = [];
  for (let i = 0; i < PROPOSALS_MAX + 5; i++) {
    list = upsertProposal(list, proposal({ id: `p${i}`, at: NOW + i }));
  }
  assert.equal(list.length, PROPOSALS_MAX);
});

test('re-proposing the same id keeps the signatures already on it', () => {
  let list = upsertProposal([], proposal());
  list = applySignature(list, 'p1', 'bob', NOW + 1);
  list = upsertProposal(list, proposal({ why: 'a better reason' }));
  assert.equal(list[0].why, 'a better reason');
  assert.equal(list[0].signatures.length, 2);
});

test('awaitingFrom is what puts a proposal in front of you', () => {
  let list = [proposal()];
  assert.equal(awaitingFrom(list[0], 'bob'), true);
  assert.equal(awaitingFrom(list[0], 'marek'), false, 'the proposer has already signed');
  list = applyObjection(list, 'p1', 'bob', 'no', NOW + 1);
  assert.equal(awaitingFrom(list[0], 'bob'), false, 'objecting is answering');
});

test('whoever put it forward can withdraw it, and so can an admin', () => {
  const p = proposal();
  assert.equal(canWithdraw(p, 'marek', false), true);
  assert.equal(canWithdraw(p, 'alice', true), true);
  assert.equal(canWithdraw(p, 'alice', false), false);
});

test('exactly one member executes a carried proposal', () => {
  // Every client watches the same ledger, so without a rule every admin
  // online would call addMember at once.
  const roles = { dana: 'admin', alice: 'admin' };
  assert.equal(admitter(roles, CIRCLE), 'alice', 'first admin in roster order');
  assert.equal(admitter({}, CIRCLE), null, 'a circle with no admin admits nobody');
});

test('a rebroadcast cannot undo a signature this device has already seen', () => {
  let mine = upsertProposal([], proposal());
  mine = applySignature(mine, 'p1', 'bob', NOW + 1);
  const merged = mergeProposals(mine, normalizeProposals([{ ...proposal(), signatures: [] }], NOW));
  assert.equal(merged[0].signatures.length, 2);
});
