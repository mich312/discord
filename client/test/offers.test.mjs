// Lifts and kit: the board block a circle fills in for itself.
//
// Everything here arrives inside an MLS envelope written by another member's
// client, so the interesting cases are all the hostile or racing ones — a
// seat taken twice, a seat taken by somebody claiming to be somebody else, a
// line that would push a megabyte into every member's backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFER_MAX,
  OFFERS_MAX,
  SEATS_MAX,
  applyTake,
  canRemoveOffer,
  mergeOffers,
  normalizeOffer,
  normalizeOffers,
  seatsLeft,
  upsertOffer,
} from '../src/lib/offers.js';

const NOW = 1_700_000_000_000;
const offer = (over = {}) =>
  normalizeOffer({ id: 'o1', text: 'Leeds → Otley, 07:00', seats: 3, ts: NOW, ...over }, 'marek', NOW);

test('the author is the sender, never the payload', () => {
  // The one field a member could otherwise use to put words in someone
  // else's mouth on the board everybody reads.
  const o = normalizeOffer({ id: 'o1', text: 'spare wheels', author: 'alice', ts: NOW }, 'dana', NOW);
  assert.equal(o.author, 'dana');
});

test('a line is bounded before it reaches anyone else', () => {
  const o = normalizeOffer(
    { id: 'x'.repeat(200), text: 'a'.repeat(5000), note: 'b'.repeat(5000), seats: 1e9, ts: NOW },
    'marek',
    NOW,
  );
  assert.equal(o.id.length, 40);
  assert.equal(o.text.length, OFFER_MAX);
  assert.equal(o.note.length, OFFER_MAX);
  assert.equal(o.seats, SEATS_MAX);
});

test('a line with no text is not a line', () => {
  assert.equal(normalizeOffer({ id: 'o1', text: '   ', ts: NOW }, 'marek', NOW), null);
  assert.equal(normalizeOffer({ text: 'no id', ts: NOW }, 'marek', NOW), null);
  assert.equal(normalizeOffer(null, 'marek', NOW), null);
});

test('a far-future timestamp cannot pin a line to the top forever', () => {
  const o = normalizeOffer({ id: 'o1', text: 'hi', ts: NOW + 86400e3 }, 'marek', NOW);
  assert.equal(o.ts, NOW);
});

test('seats of zero means a fact, not a thing to claim', () => {
  assert.equal(seatsLeft(offer({ seats: 0 })), null);
  assert.equal(seatsLeft(offer({ seats: 3 })), 3);
});

test('taking a seat is idempotent, and giving it back works', () => {
  let list = [offer()];
  list = applyTake(list, 'o1', 'bob', true);
  list = applyTake(list, 'o1', 'bob', true);
  assert.deepEqual(list[0].takers, ['bob'], 'taking twice is still one seat');
  assert.equal(seatsLeft(list[0]), 2);
  list = applyTake(list, 'o1', 'bob', false);
  assert.deepEqual(list[0].takers, []);
  // Giving back a seat you never had is a no-op, not a crash.
  list = applyTake(list, 'o1', 'nobody', false);
  assert.deepEqual(list[0].takers, []);
});

test('the last seat cannot go to two people', () => {
  // The normal case, not the edge one: everybody reads the board at once and
  // taps at once. Log order decides, and the loser sees a full car rather
  // than a seat that quietly does not exist.
  let list = [offer({ seats: 1 })];
  list = applyTake(list, 'o1', 'bob', true);
  list = applyTake(list, 'o1', 'dana', true);
  assert.deepEqual(list[0].takers, ['bob']);
  assert.equal(seatsLeft(list[0]), 0);
});

test('a line with no seats cannot be taken at all', () => {
  const list = applyTake([offer({ seats: 0 })], 'o1', 'bob', true);
  assert.deepEqual(list[0].takers, []);
});

test('editing a line keeps the people who already took a seat', () => {
  // The line changed; the promise did not.
  let list = upsertOffer([], offer());
  list = applyTake(list, 'o1', 'bob', true);
  list = upsertOffer(list, offer({ text: 'Leeds → Otley, 06:45' }));
  assert.equal(list[0].text, 'Leeds → Otley, 06:45');
  assert.deepEqual(list[0].takers, ['bob']);
});

test('the board is capped and newest first', () => {
  let list = [];
  for (let i = 0; i < OFFERS_MAX + 6; i++) {
    list = upsertOffer(list, offer({ id: `o${i}`, ts: NOW + i }));
  }
  assert.equal(list.length, OFFERS_MAX);
  assert.ok(list[0].ts > list[1].ts, 'newest first');
});

test('whoever posted it can take it down, and so can an admin', () => {
  const o = offer();
  assert.equal(canRemoveOffer(o, 'marek', false), true, 'the author');
  assert.equal(canRemoveOffer(o, 'alice', true), true, 'an admin');
  assert.equal(canRemoveOffer(o, 'alice', false), false, 'anyone else');
  assert.equal(canRemoveOffer(null, 'marek', true), false);
});

test('a whole list off the wire is bounded, and takers cannot exceed seats', () => {
  const wire = [
    { id: 'a', text: 'one seat', seats: 1, ts: NOW, author: 'marek', takers: ['bob', 'dana', 'ed'] },
    { id: 'b', text: 'a fact', seats: 0, ts: NOW - 1, author: 'dana', takers: ['bob'] },
    { id: 'c', text: '', seats: 2, ts: NOW, author: 'x' },
  ];
  const out = normalizeOffers(wire, NOW);
  assert.equal(out.length, 2, 'the empty line is dropped');
  assert.deepEqual(out[0].takers, ['bob'], 'a one-seat car holds one person');
  assert.deepEqual(out[1].takers, [], 'a fact has no takers');
});

test('a rebroadcast cannot undo a claim this device has already seen', () => {
  // The joiner gap-fill only ever adds. A rebroadcaster whose copy predates
  // the claim would otherwise hand back an empty car.
  let mine = upsertOffer([], offer());
  mine = applyTake(mine, 'o1', 'bob', true);
  const merged = mergeOffers(mine, normalizeOffers([{ ...offer(), takers: [] }], NOW));
  assert.deepEqual(merged[0].takers, ['bob']);
});
