// Home-base rules: normalization bounds, noticeboard merge/permissions,
// and the countdown/relative-time labels — all pure, all with a fixed
// clock so nothing here depends on when the suite runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLURB_MAX,
  NOTICES_MAX,
  EVENTS_MAX,
  canRemoveNotice,
  describeAgo,
  describeUntil,
  mergeNotices,
  normalizeEvents,
  normalizeNotice,
  normalizeOverview,
  reconcileMeta,
  upsertNotice,
} from '../src/lib/overview.js';

const NOW = 1_800_000_000_000; // fixed clock
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;

test('normalizeOverview keeps only whitelisted, bounded fields', () => {
  const ov = normalizeOverview(
    {
      blurb: ' hello ',
      links: [
        { label: 'a', url: 'https://a.example' },
        { label: 'no url dropped' },
      ],
      events: [
        { id: 'ev1', title: 'race day', at: NOW + DAY, note: 'gates at 8', gameId: 'g1', extra: 'dropped' },
      ],
      smuggled: { huge: 'x' },
    },
    NOW
  );
  assert.deepEqual(ov, {
    blurb: 'hello',
    links: [{ label: 'a', url: 'https://a.example' }],
    events: [{ id: 'ev1', title: 'race day', at: NOW + DAY, note: 'gates at 8', gameId: 'g1' }],
    // A legacy single-event mirror rides along for older clients.
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

test('an event needs a title and a finite time', () => {
  assert.equal(normalizeOverview({ events: [{ title: '', at: NOW }] }, NOW), null);
  assert.equal(normalizeOverview({ events: [{ title: 'x', at: 'soon' }] }, NOW), null);
  const ok = normalizeOverview({ events: [{ id: 'e1', title: 'x', at: NOW, note: '' }] }, NOW);
  assert.deepEqual(ok.events, [{ id: 'e1', title: 'x', at: NOW }]);
  assert.deepEqual(ok.event, { title: 'x', at: NOW });
});

test('normalizeOverview reads a legacy single event into the events array', () => {
  const ov = normalizeOverview({ event: { title: 'race day', at: NOW + DAY } }, NOW);
  assert.equal(ov.events.length, 1);
  assert.equal(ov.events[0].title, 'race day');
  assert.ok(ov.events[0].id, 'a stable id is derived when none was given');
  assert.deepEqual(ov.event, { title: 'race day', at: NOW + DAY }, 'mirror still written');
});

test('the legacy mirror is the soonest upcoming event, else the most recent past', () => {
  const events = [
    { id: 'past', title: 'gone', at: NOW - 2 * DAY },
    { id: 'later', title: 'after', at: NOW + DAY },
    { id: 'soon', title: 'next', at: NOW + HOUR },
  ];
  const ov = normalizeOverview({ events }, NOW);
  assert.deepEqual(ov.events.map((e) => e.id), ['past', 'soon', 'later'], 'sorted soonest-first');
  assert.equal(ov.event.title, 'next', 'soonest upcoming is mirrored');
  const allPast = normalizeOverview(
    { events: [{ id: 'a', title: 'A', at: NOW - 3 * DAY }, { id: 'b', title: 'B', at: NOW - DAY }] },
    NOW
  );
  assert.equal(allPast.event.title, 'B', 'no upcoming → most recent past');
});

test('normalizeEvents bounds, de-dupes by id, and tolerates junk', () => {
  const many = Array.from({ length: EVENTS_MAX + 6 }, (_, i) => ({
    id: `e${i}`,
    title: `t${i}`,
    at: NOW + i * HOUR,
  }));
  assert.equal(normalizeEvents(many).length, EVENTS_MAX);
  const dup = normalizeEvents([
    { id: 'x', title: 'first', at: NOW + DAY },
    { id: 'x', title: 'dup', at: NOW + HOUR },
  ]);
  assert.deepEqual(dup.map((e) => e.title), ['first'], 'first id wins, dup dropped');
  assert.deepEqual(normalizeEvents('nope'), []);
});

test('gameId is kept, bounded, and optional', () => {
  const ev = normalizeOverview({ events: [{ id: 'e', title: 't', at: NOW, gameId: 'g1' }] }, NOW).events[0];
  assert.equal(ev.gameId, 'g1');
  const none = normalizeOverview({ events: [{ id: 'e', title: 't', at: NOW }] }, NOW).events[0];
  assert.equal('gameId' in none, false);
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

test('reconcileMeta adopts the snapshot wholesale so deletions land', () => {
  // A device holding a stale shape (a phantom channel a departed admin
  // deleted, a stale game hub, an unpinned notice) reconciles to the
  // rebroadcaster's authoritative snapshot — the shape must be allowed to
  // *shrink*, unlike the union gap-fill.
  const snapshot = {
    channels: ['general', 'general', 'racing'], // deduped; 'photos' is gone
    voiceChannels: ['lounge'],
    overview: { games: [{ id: 'g1', name: 'Chess', url: 'https://chess.example' }] },
    chanMeta: { racing: { topic: 'sunday laps' } },
    notices: [{ id: 'keep', text: 'still pinned', ts: NOW, author: 'alice' }],
  };
  const out = reconcileMeta(snapshot);
  assert.deepEqual(out.channels, ['general', 'racing']); // 'photos' dropped, deduped
  assert.deepEqual(out.voiceChannels, ['lounge']);
  assert.equal(out.overview.games.length, 1); // game hub finally arrives
  assert.deepEqual(out.chanMeta, { racing: { topic: 'sunday laps' } });
  assert.deepEqual(out.notices.map((n) => n.id), ['keep']);
});

test('reconcileMeta touches only fields present in the snapshot', () => {
  // Missing/empty channel or voice lists must not blank out the record —
  // the caller keeps its current list. A null overview *is* meaningful
  // (admin cleared the game hub) and is adopted.
  const out = reconcileMeta({ overview: null, channels: [] });
  assert.deepEqual(Object.keys(out).sort(), ['overview']);
  assert.equal(out.overview, null);
  assert.deepEqual(reconcileMeta({}), {});
});

test('reconcileMeta normalizes hostile snapshot fields', () => {
  const out = reconcileMeta({
    overview: { blurb: ' hi ', smuggled: 'x'.repeat(99) },
    notices: [
      { id: 'n2', text: 'newer', ts: NOW, author: 'bob' },
      { id: 'n1', text: 'older', ts: NOW - MIN, author: 'alice' },
      { id: '', text: 'junk' }, // dropped
    ],
    rsvps: { alice: { at: NOW + DAY }, bad: { at: 'soon' } },
  });
  assert.deepEqual(out.overview, { blurb: 'hi', links: [] });
  assert.deepEqual(out.notices.map((n) => n.id), ['n2', 'n1']); // newest first, junk gone
  assert.deepEqual(Object.keys(out.rsvps), ['alice']); // non-finite time dropped
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
