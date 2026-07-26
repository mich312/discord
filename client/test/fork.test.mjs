// Fork detection. The risk this file is really guarding is the false
// positive: undecryptable blobs are a normal part of operation, and a module
// that cries "your circle is broken" at the ordinary ones would be worse than
// having no detection at all. So the expected-failure cases get as much
// coverage as the fork itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, forkMessage, ForkWatch, FORK_THRESHOLD } from '../src/lib/fork.js';

const me = 'alice';

/* --------------------------------------------------------- classifying -- */

test('our own replayed commits are expected, never evidence', () => {
  // The most common undecryptable blob there is: catch-up hands us back the
  // commits we sent. Counting these would flag every healthy device.
  assert.equal(classifyFailure({ sender: me, epoch: 4, me, groupEpoch: 4 }), 'self');
});

test('a blob from an epoch we have not reached yet is expected', () => {
  // We are behind, not forked; the commit that opens it is still in flight.
  assert.equal(classifyFailure({ sender: 'bob', epoch: 7, me, groupEpoch: 6 }), 'ahead');
});

test('a restored read-only stub explains every failure by itself', () => {
  // It holds no MLS state at all, so nothing decrypts by design.
  assert.equal(
    classifyFailure({ sender: 'bob', epoch: 3, me, groupEpoch: 6, restored: true }),
    'restored'
  );
});

test('someone else at an epoch we have already reached is the fork signature', () => {
  assert.equal(classifyFailure({ sender: 'bob', epoch: 6, me, groupEpoch: 6 }), 'suspect');
  assert.equal(classifyFailure({ sender: 'bob', epoch: 5, me, groupEpoch: 6 }), 'suspect');
});

test('a missing epoch does not get waved through as "ahead"', () => {
  // An older or hand-rolled sender may omit it. Unknown must not become an
  // excuse — otherwise omitting the field is enough to hide a fork.
  assert.equal(classifyFailure({ sender: 'bob', me, groupEpoch: 6 }), 'suspect');
  assert.equal(classifyFailure({ sender: 'bob', epoch: NaN, me, groupEpoch: 6 }), 'suspect');
});

/* ------------------------------------------------------------ counting -- */

const fail = (w, sender, over = {}) =>
  w.failed('srv', { sender, epoch: 6, me, groupEpoch: 6, ...over });

test('one success wipes out a sender’s accumulated suspicion', () => {
  // A blob that opens proves the ratchet is still shared. Decaying the count
  // instead of clearing it would let unrelated failures spread over a long
  // session eventually cross the line.
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD - 1; i++) fail(w, 'bob');
  w.succeeded('srv', 'bob');
  fail(w, 'bob');
  assert.deepEqual(w.verdict('srv'), { stranded: [], outOfSync: false });
});

test('expected failures never accumulate, however many arrive', () => {
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD * 4; i++) {
    fail(w, me); // self
    fail(w, 'bob', { epoch: 9 }); // ahead
    fail(w, 'carol', { restored: true }); // restored
  }
  assert.deepEqual(w.verdict('srv'), { stranded: [], outOfSync: false });
});

test('the threshold is a floor, not a fencepost', () => {
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD - 1; i++) fail(w, 'bob');
  assert.deepEqual(w.verdict('srv').stranded, [], 'one short must not fire');
  fail(w, 'bob');
  assert.deepEqual(w.verdict('srv').stranded, ['bob']);
});

test('failed() reports why, so the log can say something useful', () => {
  const w = new ForkWatch();
  assert.equal(fail(w, me), 'self');
  assert.equal(fail(w, 'bob', { epoch: 9 }), 'ahead');
  assert.equal(fail(w, 'bob'), 'suspect');
});

/* ------------------------------------------------------------- verdict -- */

test('every sender unreadable means THIS device is the one adrift', () => {
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD; i++) {
    fail(w, 'bob');
    fail(w, 'carol');
  }
  assert.deepEqual(w.verdict('srv'), { stranded: ['bob', 'carol'], outOfSync: true });
});

test('one unreadable sender among working ones is THEIR problem, not ours', () => {
  // The asymmetry this module exists for. alice hears bob fine and carol
  // never, so alice is not the one who needs to rejoin — and a single
  // group-wide counter would have reset on every bob message and reported
  // nothing at all.
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD; i++) fail(w, 'carol');
  w.succeeded('srv', 'bob');
  const v = w.verdict('srv');
  assert.deepEqual(v.stranded, ['carol']);
  assert.equal(v.outOfSync, false, 'we can still hear bob, so we are not the broken one');
});

test('groups are tallied independently', () => {
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD; i++) {
    w.failed('srv', { sender: 'bob', epoch: 6, me, groupEpoch: 6 });
  }
  assert.equal(w.verdict('srv').outOfSync, true);
  assert.deepEqual(w.verdict('other'), { stranded: [], outOfSync: false });
});

test('clear() forgets a group, so a rejoin starts clean', () => {
  const w = new ForkWatch();
  for (let i = 0; i < FORK_THRESHOLD; i++) fail(w, 'bob');
  assert.equal(w.verdict('srv').outOfSync, true);
  w.clear('srv');
  assert.deepEqual(w.verdict('srv'), { stranded: [], outOfSync: false });
});

test('an untouched group is never out of sync', () => {
  // outOfSync compares stranded against the senders seen; with none seen at
  // all that comparison must not degenerate into 0 === 0.
  assert.deepEqual(new ForkWatch().verdict('srv'), { stranded: [], outOfSync: false });
});

/* ------------------------------------------------------------- wording -- */

test('the out-of-sync message tells the user what to actually do', () => {
  const m = forkMessage({ stranded: ['bob'], outOfSync: true }, 'Book Club');
  assert.match(m, /Book Club/);
  assert.match(m, /invite link/, 'the only real remedy must be in the sentence');
});

test('a stranded member reads as their problem, singular or plural', () => {
  assert.match(
    forkMessage({ stranded: ['carol'], outOfSync: false }, 'Book Club'),
    /messages from carol/
  );
  assert.match(
    forkMessage({ stranded: ['carol', 'dave'], outOfSync: false }, 'Book Club'),
    /messages from carol, dave/
  );
});

test('a healthy circle produces no message at all', () => {
  assert.equal(forkMessage({ stranded: [], outOfSync: false }, 'Book Club'), null);
});
