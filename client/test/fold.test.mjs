// Message grouping, as a security property.
//
// A group renders one header, and that header carries the sender's trust
// badge. So which lines land in a group decides which lines a badge vouches
// for — which makes fold() security-relevant rather than cosmetic.
//
// The distinction it has to hold: a live line is signed by the sender's key,
// and the check means "I compared that key". A restored line was never signed
// by its sender — it is sealed with the room key, which every current *and
// former* member of a kept-history room holds. The threat model accepts that
// a former member can forge one, on the stated condition that the UI says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../src/lib/fold.js';

const at = (ts, extra = {}) => ({ sender: 'bob', text: 'x', ts, ...extra });
const groups = (msgs) => fold(msgs).filter((i) => i.kind === 'group');

test('consecutive live lines from one sender group together', () => {
  const g = groups([at(1000), at(2000), at(3000)]);
  assert.equal(g.length, 1);
  assert.equal(g[0].lines.length, 3);
  assert.equal(g[0].fromHistory, false);
});

test('a restored line never joins a live group, however close in time', () => {
  // Same sender, one second apart — comfortably inside the grouping window,
  // and the two would merge on every other axis.
  const g = groups([at(1000), at(2000, { fromHistory: true })]);
  assert.equal(g.length, 2, 'restored and live lines must not share a header');
  assert.equal(g[0].fromHistory, false);
  assert.equal(g[1].fromHistory, true);
});

test('a live line does not join a restored group either', () => {
  const g = groups([at(1000, { fromHistory: true }), at(2000)]);
  assert.equal(g.length, 2);
  assert.equal(g[0].fromHistory, true);
  assert.equal(g[1].fromHistory, false);
});

test('restored lines group with each other', () => {
  const g = groups([
    at(1000, { fromHistory: true }),
    at(2000, { fromHistory: true }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].lines.length, 2);
  assert.equal(g[0].fromHistory, true);
});

test('every group reports its provenance, so a renderer cannot forget to ask', () => {
  const g = groups([at(1000), at(9e6, { fromHistory: true }), at(9e6 + 1000)]);
  for (const grp of g) {
    assert.equal(typeof grp.fromHistory, 'boolean', 'fromHistory must never be undefined');
  }
});

test('no group ever mixes provenance', () => {
  // A realistic interleaving: a restore lands in the middle of a live thread.
  const msgs = [
    at(1000),
    at(1500),
    at(2000, { fromHistory: true }),
    at(2500, { fromHistory: true }),
    at(3000),
  ];
  for (const g of groups(msgs)) {
    const kinds = new Set(g.lines.map((l) => !!l.fromHistory));
    assert.equal(kinds.size, 1, 'a single header would vouch for both kinds');
  }
});
