// The rail was pure identity — colour and monogram, nothing else — so a
// circle you were not looking at could fill up with no signal at all. These
// cover the counting rules the badges are built on, which were previously
// inline in channelDigest and untested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countUnread, seenFloor } from '../src/lib/controller.js';

const ME = 'alice';
const msg = (ts, sender = 'bob', extra = {}) => ({ ts, sender, text: 'hi', ...extra });

/* ---------------------------------------------------------- countUnread -- */

test('only messages newer than the seen marker count', () => {
  const msgs = [msg(100), msg(200), msg(300)];
  assert.equal(countUnread(msgs, 0, ME), 3);
  assert.equal(countUnread(msgs, 200, ME), 1);
  assert.equal(countUnread(msgs, 300, ME), 0);
});

test('the marker is exclusive — the message you last read is read', () => {
  // markSeen anchors on the newest message's ts, so an inclusive comparison
  // would leave every room permanently one-unread.
  assert.equal(countUnread([msg(200)], 200, ME), 0);
});

test('your own messages are never unread', () => {
  // Sending is reading. This also protects against a device whose clock runs
  // ahead of the one that marked the room seen.
  assert.equal(countUnread([msg(300, ME), msg(400, ME)], 0, ME), 0);
  assert.equal(countUnread([msg(300, ME), msg(400, 'bob')], 0, ME), 1);
});

test('system chips are chrome, not conversation', () => {
  // "carol joined" must not light up a circle.
  assert.equal(countUnread([msg(300, 'carol', { system: true })], 0, ME), 0);
});

test('a missing or unparseable timestamp never counts as new', () => {
  // A hostile or ancient payload should not be able to pin a badge on.
  for (const ts of [undefined, null, NaN, 'soon', -1]) {
    assert.equal(countUnread([msg(ts)], 0, ME), 0, `ts=${String(ts)}`);
  }
});

test('an empty or absent room reads as zero rather than throwing', () => {
  assert.equal(countUnread([], 0, ME), 0);
  assert.equal(countUnread(undefined, 0, ME), 0);
});

test('counting does not depend on message order', () => {
  // msgsFor returns index order, which is not guaranteed to be by ts.
  const shuffled = [msg(300), msg(100), msg(400), msg(200)];
  assert.equal(countUnread(shuffled, 250, ME), 2);
});

/* ----------------------------------------------------------- seenFloor -- */

test('a room you have opened counts from when you opened it', () => {
  assert.equal(seenFloor({ seen: { general: 500 }, joinedAt: 100 }, 'general'), 500);
});

test('a room you have never opened counts from when you joined the circle', () => {
  // Falling back to 0 would count the entire backfilled history of a circle
  // as unread the moment you were added to it.
  assert.equal(seenFloor({ seen: {}, joinedAt: 100 }, 'general'), 100);
  assert.equal(seenFloor({ joinedAt: 100 }, 'general'), 100);
});

test('a record with neither falls back to counting everything', () => {
  // Over-reporting is the safe direction: a badge that should not be there
  // is noticed and cleared, a missed message is not.
  assert.equal(seenFloor({}, 'general'), 0);
  assert.equal(seenFloor(undefined, 'general'), 0);
});

test('a seen marker of zero is honoured, not treated as absent', () => {
  assert.equal(seenFloor({ seen: { general: 0 }, joinedAt: 100 }, 'general'), 0);
});

/* ------------------------------------------------- the roll-up together -- */

test('a circle total is the sum of its rooms, under the same rules', () => {
  // What circleUnreads() computes per circle, without a database.
  const record = { seen: { general: 200 }, joinedAt: 50 };
  const rooms = {
    general: [msg(100), msg(300), msg(400)], // 2 past the marker
    random: [msg(60), msg(70, ME)], // 1 past joinedAt, one of them ours
    quiet: [],
  };
  const total = Object.entries(rooms).reduce(
    (n, [channel, msgs]) => n + countUnread(msgs, seenFloor(record, channel), ME),
    0,
  );
  assert.equal(total, 3);
});
