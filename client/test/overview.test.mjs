// Home-base rules: normalization bounds, noticeboard merge/permissions,
// and the countdown/relative-time labels — all pure, all with a fixed
// clock so nothing here depends on when the suite runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLURB_MAX,
  NOTICES_MAX,
  canRemoveNotice,
  describeAgo,
  describeUntil,
  mergeNotices,
  normalizeNotice,
  normalizeOverview,
  upsertNotice,
} from '../src/lib/overview.js';

const NOW = 1_800_000_000_000; // fixed clock
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;

test('normalizeOverview keeps only whitelisted, bounded fields', () => {
  const ov = normalizeOverview({
    blurb: ' hello ',
    links: [
      { label: 'a', url: 'https://a.example' },
      { label: 'no url dropped' },
    ],
    event: { title: 'race day', at: NOW + DAY, note: 'gates at 8', extra: 'dropped' },
    smuggled: { huge: 'x' },
  });
  assert.deepEqual(ov, {
    blurb: 'hello',
    links: [{ label: 'a', url: 'https://a.example' }],
    event: { title: 'race day', at: NOW + DAY, note: 'gates at 8' },
  });
});

test('normalizeOverview bounds the blurb and rejects empty docs', () => {
  const long = normalizeOverview({ blurb: 'x'.repeat(BLURB_MAX * 2) });
  assert.equal(long.blurb.length, BLURB_MAX);
  assert.equal(normalizeOverview({}), null);
  assert.equal(normalizeOverview({ blurb: '   ', links: [] }), null);
  assert.equal(normalizeOverview('nope'), null);
});

test('event needs a title and a finite time', () => {
  assert.equal(normalizeOverview({ event: { title: '', at: NOW } }), null);
  assert.equal(normalizeOverview({ event: { title: 'x', at: 'soon' } }), null);
  const ok = normalizeOverview({ event: { title: 'x', at: NOW, note: '' } });
  assert.deepEqual(ok.event, { title: 'x', at: NOW });
});

test('normalizeNotice takes the author from the sender, never the payload', () => {
  const n = normalizeNotice({ id: 'n1', text: 'hi', ts: NOW - MIN, author: 'mallory' }, 'alice', NOW);
  assert.equal(n.author, 'alice');
  assert.equal(n.ts, NOW - MIN);
});

test('normalizeNotice clamps far-future timestamps to now', () => {
  const n = normalizeNotice({ id: 'n1', text: 'hi', ts: NOW + DAY }, 'alice', NOW);
  assert.equal(n.ts, NOW);
  assert.equal(normalizeNotice({ id: '', text: 'hi' }, 'a', NOW), null);
  assert.equal(normalizeNotice({ id: 'x', text: '  ' }, 'a', NOW), null);
});

test('upsertNotice replaces by id, keeps newest first, and caps the board', () => {
  let list = [];
  for (let i = 0; i < NOTICES_MAX + 5; i++) {
    list = upsertNotice(list, { id: `n${i}`, text: 't', ts: NOW + i, author: 'a' });
  }
  assert.equal(list.length, NOTICES_MAX);
  assert.equal(list[0].id, `n${NOTICES_MAX + 4}`); // newest first
  list = upsertNotice(list, { id: list[3].id, text: 'edited', ts: list[3].ts, author: 'a' });
  assert.equal(list.filter((n) => n.text === 'edited').length, 1);
  assert.equal(list.length, NOTICES_MAX);
});

test('mergeNotices unions by id and my copy wins', () => {
  const mine = [{ id: 'a', text: 'mine', ts: NOW, author: 'alice' }];
  const theirs = [
    { id: 'a', text: 'theirs', ts: NOW, author: 'alice' },
    { id: 'b', text: 'new', ts: NOW - MIN, author: 'bob' },
  ];
  const merged = mergeNotices(mine, theirs);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((n) => n.id === 'a').text, 'mine');
});

test('canRemoveNotice: author yes, admin yes, known member no, unknown fails open', () => {
  const n = { id: 'x', text: 't', ts: NOW, author: 'bob' };
  const roles = { alice: 'admin', bob: 'member', carol: 'member' };
  assert.equal(canRemoveNotice(n, 'bob', roles), true);
  assert.equal(canRemoveNotice(n, 'alice', roles), true);
  assert.equal(canRemoveNotice(n, 'carol', roles), false);
  assert.equal(canRemoveNotice(n, 'stranger', roles), true); // role unknown -> fail open
  assert.equal(canRemoveNotice(null, 'alice', roles), false);
});

test('describeUntil ranges', () => {
  assert.equal(describeUntil(NOW + 30e3, NOW), 'in under a minute');
  assert.equal(describeUntil(NOW + 45 * MIN, NOW), 'in 45 min');
  assert.equal(describeUntil(NOW + 5 * HOUR, NOW), 'in 5 h');
  assert.equal(describeUntil(NOW + 3 * DAY, NOW), 'in 3 days');
  assert.equal(describeUntil(NOW - HOUR, NOW), 'now'); // 6 h grace while it is on
  assert.equal(describeUntil(NOW - 3 * DAY, NOW), '3 days ago');
});

test('describeAgo ranges', () => {
  assert.equal(describeAgo(NOW - 10e3, NOW), 'just now');
  assert.equal(describeAgo(NOW - 30 * MIN, NOW), '30 min ago');
  assert.equal(describeAgo(NOW - 7 * HOUR, NOW), '7 h ago');
  assert.equal(describeAgo(NOW - 4 * DAY, NOW), '4 days ago');
});
