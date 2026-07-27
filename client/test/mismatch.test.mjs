// Safety-number outcomes as state transitions.
//
// The dialog used to have one button, and it granted trust. A user who did
// the comparison properly and found it *wrong* had nothing to press and left
// no trace — so the only outcome the product could record was the reassuring
// one. These assertions pin the two rules that makes safe:
//
//   · a mismatch retracts any standing verification, rather than sitting
//     beside it — the two claims cannot both be live, and the unsafe one
//     must not win by being older
//   · a mismatch is spent once the key it was about is gone, because nobody
//     ever compared against the key the member now holds
//
// The controller wants a worker, a relay and IndexedDB, so these exercise the
// same transitions against the record shape it persists.
import test from 'node:test';
import assert from 'node:assert/strict';

// The real transitions, imported from the module the controller calls — not
// a copy. A test that re-implements the logic it is checking asserts only
// that the author wrote the same thing twice.
import { applyVerified, applyMismatch, retireMismatch } from '../src/lib/trust.js';

const markVerified = applyVerified;
const markMismatch = applyMismatch;

/** `now` maps peer -> the safety number that peer derives to today. */
function revalidate(record, now) {
  for (const peer of Object.keys(record.mismatched ?? {})) {
    if (now[peer] !== undefined) retireMismatch(record, peer, now[peer]);
  }
  for (const [peer, was] of Object.entries(record.verifiedSn ?? {})) {
    if (now[peer] !== undefined && now[peer] !== was) delete record.verifiedSn[peer];
  }
  record.verified = Object.keys(record.verifiedSn ?? {});
  return record;
}

const blank = () => ({ id: 's', members: ['bob'], verified: [], verifiedSn: {}, mismatched: {} });

test('a mismatch is recorded against the number that was compared', () => {
  const r = markMismatch(blank(), 'bob', '111');
  assert.equal(r.mismatched.bob, '111');
});

test('a mismatch retracts a standing verification', () => {
  const r = markVerified(blank(), 'bob', '111');
  assert.deepEqual(r.verified, ['bob']);
  markMismatch(r, 'bob', '111');
  assert.deepEqual(r.verified, [], 'a verified badge must not survive a found mismatch');
  assert.equal(r.verifiedSn.bob, undefined);
  assert.equal(r.mismatched.bob, '111');
});

test('verifying clears a previous mismatch — they compared again and it matched', () => {
  const r = markMismatch(blank(), 'bob', '111');
  markVerified(r, 'bob', '222');
  assert.equal(r.mismatched.bob, undefined);
  assert.deepEqual(r.verified, ['bob']);
});

test('a mismatch survives while the key it was about is still in front of you', () => {
  const r = markMismatch(blank(), 'bob', '111');
  revalidate(r, { bob: '111' });
  assert.equal(r.mismatched.bob, '111', 'the same key must keep the warning');
});

test('a mismatch is cleared once the key changes, and does not become a verification', () => {
  const r = markMismatch(blank(), 'bob', '111');
  revalidate(r, { bob: '999' });
  assert.equal(r.mismatched.bob, undefined, 'the finding was about a key that is gone');
  assert.deepEqual(r.verified, [], 'clearing a warning must never imply trust');
});

test('a verification is still cleared by a key change', () => {
  const r = markVerified(blank(), 'bob', '111');
  revalidate(r, { bob: '999' });
  assert.deepEqual(r.verified, []);
});

test('the two states are never both live for one peer', () => {
  const r = blank();
  for (const step of [
    () => markVerified(r, 'bob', '111'),
    () => markMismatch(r, 'bob', '111'),
    () => markVerified(r, 'bob', '222'),
    () => markMismatch(r, 'bob', '222'),
  ]) {
    step();
    const verified = !!r.verifiedSn?.bob;
    const mismatched = !!r.mismatched?.bob;
    assert.ok(!(verified && mismatched), 'a peer cannot be verified and mismatched at once');
  }
});
