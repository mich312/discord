// Which half of a circle goes where. The rule these tests pin down is the
// one the storage split rests on: a field belongs on the relay unless a
// second device of the same account could legitimately disagree about it.
// Getting it wrong in one direction leaks a private judgement to every
// device; in the other, a circle loses its name on reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceHalf, hydrate, mergeBackups, sharedHalf } from '../src/lib/circles.js';

const full = (over = {}) => ({
  id: 'srv',
  name: 'sunday cyclists',
  channels: ['general', 'routes'],
  voiceChannels: ['lounge'],
  chanMeta: { general: { hid: 'h1', hkey: 'k1', topic: 'chat' } },
  keys: { bob: 'bobkey' },
  overview: { blurb: 'we ride' },
  notices: [{ id: 'n1', text: 'pinned' }],
  rsvps: { alice: { at: 1, ts: 2 } },
  invites: [{ id: 'inv1', key: 'fragkey' }],
  deletedChannels: ['old-room'],
  deletedVoice: ['old-voice'],
  lastSeq: 42,
  epoch: 7,
  seen: { general: 1234 },
  verified: ['bob'],
  verifiedSn: { bob: '1234' },
  mismatched: { carol: '9999' },
  joinedAt: 99,
  members: ['alice', 'bob'],
  roles: { alice: 'admin' },
  ...over,
});

test('the shared half carries everything a second device must agree about', () => {
  const s = sharedHalf(full());
  assert.equal(s.name, 'sunday cyclists');
  assert.deepEqual(s.channels, ['general', 'routes']);
  assert.equal(s.chanMeta.general.hkey, 'k1', 'the room key travels with the circle');
  assert.deepEqual(s.keys, { bob: 'bobkey' });
  assert.deepEqual(s.rsvps, { alice: { at: 1, ts: 2 } });
  // Both of these used to live only in the local record, which is why they
  // are named here: without the fragment key a device stops refreshing an
  // invite link that still looks live, and without the tombstones the meta
  // union resurrects a deleted room on the next boot.
  assert.deepEqual(s.invites, [{ id: 'inv1', key: 'fragkey' }]);
  assert.deepEqual(s.deletedChannels, ['old-room']);
  assert.deepEqual(s.deletedVoice, ['old-voice']);
});

test('the shared half carries no cursor, no read marker and no verification', () => {
  const s = sharedHalf(full());
  for (const leaked of ['lastSeq', 'epoch', 'seen', 'verified', 'verifiedSn', 'mismatched']) {
    assert.equal(s[leaked], undefined, `${leaked} must not reach the relay's blob`);
  }
  // Derived from the MLS roster and the relay's ACL on every connect. A
  // stored copy could only ever be the staler answer.
  assert.equal(s.members, undefined);
  assert.equal(s.roles, undefined);
});

test('the device half keeps this device’s own answers and nothing else', () => {
  const d = deviceHalf(full());
  assert.equal(d.lastSeq, 42);
  assert.equal(d.epoch, 7);
  assert.deepEqual(d.seen, { general: 1234 });
  assert.deepEqual(d.verifiedSn, { bob: '1234' }, 'a comparison made on this device, in person');
  assert.deepEqual(d.mismatched, { carol: '9999' });
  assert.equal(d.name, undefined, 'the circle itself is not duplicated here');
  assert.equal(d.chanMeta, undefined, 'and neither are the room keys');
  assert.equal(d.live, undefined, 'whether we can send is asked of the ratchet, not stored');
});

test('a circle hydrates read-only when this device holds no ratchet for it', () => {
  const r = hydrate(sharedHalf(full()), undefined, { now: 5000, live: false });
  assert.equal(r.name, 'sunday cyclists');
  assert.equal(r.chanMeta.general.hkey, 'k1', 'readable: the room key came from the blob');
  assert.equal(r.restored, true, 'but not sendable');
  assert.equal(r.lastSeq, 0);
  // Not 0: an unread count floored at the epoch would mark a circle's entire
  // past as missed the moment this device learned the circle exists.
  assert.equal(r.joinedAt, 5000);
  assert.deepEqual(r.members, [], 're-read from the roster, never from the blob');
});

test('a circle this device is live in hydrates with its own cursor and judgements', () => {
  const r = hydrate(sharedHalf(full()), deviceHalf(full()), { live: true });
  assert.ok(!r.restored);
  assert.equal(r.lastSeq, 42);
  assert.equal(r.epoch, 7);
  assert.deepEqual(r.seen, { general: 1234 });
  assert.deepEqual(r.verifiedSn, { bob: '1234' });
  assert.equal(r.joinedAt, 99);
});

test('a device with a ratchet but no stored device state is live, not read-only', () => {
  // The regression. `live` was once device state, which meant it was absent
  // for every install predating that store — so an upgrade marked circles
  // read-only on devices whose ratchets were sitting right there, and a
  // read-only record never even subscribes. Liveness comes from the ratchet
  // precisely so no migration can answer it wrongly.
  const r = hydrate(sharedHalf(full()), undefined, { live: true });
  assert.ok(!r.restored, 'the ratchet is what decides, and it says we can send');
  assert.equal(r.lastSeq, 0, 'the cursor is genuinely unknown, and re-earned by subscribing');
});

test('two devices of one account see different read markers over the same circle', () => {
  // The point of the split, stated as a test: one blob, two device halves.
  const shared = sharedHalf(full());
  const phone = hydrate(shared, { lastSeq: 10, seen: { general: 100 } }, { live: true });
  const laptop = hydrate(shared, { lastSeq: 90, seen: { general: 900 } }, { live: true });
  assert.equal(phone.name, laptop.name, 'the circle is the same circle');
  assert.equal(phone.chanMeta.general.hkey, laptop.chanMeta.general.hkey);
  assert.notEqual(phone.seen.general, laptop.seen.general, 'what each has read is not');
});

test('a merge keeps both sides’ circles, and ours wins where they overlap', () => {
  const mine = [
    { id: 'a', name: 'my newer name' },
    { id: 'only-mine', name: 'just joined here' },
  ];
  const theirs = [
    { id: 'a', name: 'their older name' },
    { id: 'only-theirs', name: 'joined on the phone' },
  ];
  const merged = mergeBackups(mine, theirs);
  const byId = Object.fromEntries(merged.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['a', 'only-mine', 'only-theirs']);
  assert.equal(byId.a.name, 'my newer name', 'the write that lost the swap still carries the edit');
});

test('a merge drops nothing when one side is empty or malformed', () => {
  assert.deepEqual(mergeBackups([], [{ id: 'x' }]), [{ id: 'x' }]);
  assert.deepEqual(mergeBackups(undefined, undefined), []);
  assert.deepEqual(mergeBackups([{ id: 'x' }, null, {}], []), [{ id: 'x' }], 'no id, no circle');
});
