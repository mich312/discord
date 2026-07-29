// Message grouping, as a security property.
//
// A group renders one header, and that header carries the sender's trust
// badge. So which lines land in a group decides which lines a badge vouches
// for — which makes fold() security-relevant rather than cosmetic.
//
// The distinction it has to hold is what a line's authorship rests on. A
// 'signed' line carries its author's own signature, checked against the key
// the roster holds for them, and the header's check means "and I compared
// that key myself". A line that could not be verified — written before
// entries were signed, or by someone whose key this device never learned —
// is authenticated only by the room key, which every current *and former*
// member holds. Either can be honest; they must not share a header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../src/lib/fold.js';

const at = (ts, extra = {}) => ({ sender: 'bob', text: 'x', ts, ...extra });
const groups = (msgs) => fold(msgs).filter((i) => i.kind === 'group');

test('consecutive signed lines from one sender group together', () => {
  const g = groups([at(1000), at(2000), at(3000)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].lines.length, 3);
  assert.equal(g[0].auth, 'signed', 'a line with no verdict is treated as signed');
});

test('an unverifiable line never joins a signed group, however close in time', () => {
  // Same sender, one second apart — comfortably inside the grouping window,
  // and the two would merge on every other axis.
  const g = groups([at(1000), at(2000, { auth: 'unknown' })]);
  assert.equal(g.length, 2, 'they must not share a header');
  assert.equal(g[0].auth, 'signed');
  assert.equal(g[1].auth, 'unknown');
});

test('a signed line does not join an unverifiable group either', () => {
  const g = groups([at(1000, { auth: 'unsigned' }), at(2000, { auth: 'signed' })]);
  assert.equal(g.length, 2);
  assert.equal(g[0].auth, 'unsigned');
  assert.equal(g[1].auth, 'signed');
});

test('lines with the same standing group with each other', () => {
  const g = groups([at(1000, { auth: 'unsigned' }), at(2000, { auth: 'unsigned' })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].lines.length, 2);
  assert.equal(g[0].auth, 'unsigned');
});

test('unsigned and unattributable do not group together either', () => {
  // They fail differently — one was never signed, the other was signed by a
  // key we cannot place — and the renderer may yet want to say so.
  const g = groups([at(1000, { auth: 'unsigned' }), at(2000, { auth: 'unknown' })]);
  assert.equal(g.length, 2);
});

test('every group reports its standing, so a renderer cannot forget to ask', () => {
  const g = groups([at(1000), at(9e6, { auth: 'unknown' }), at(9e6 + 1000)]);
  for (const grp of g) {
    assert.equal(typeof grp.auth, 'string', 'auth must never be undefined');
  }
});

test('no group ever mixes standing', () => {
  // A realistic interleaving: a page of older, unattributable lines lands in
  // the middle of a live thread.
  const msgs = [
    at(1000),
    at(1500),
    at(2000, { auth: 'unknown' }),
    at(2500, { auth: 'unknown' }),
    at(3000),
  ];
  for (const g of groups(msgs)) {
    const kinds = new Set(g.lines.map((l) => l.auth ?? 'signed'));
    assert.equal(kinds.size, 1, 'a single header would vouch for both kinds');
  }
});
