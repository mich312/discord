// Game-shelf rules: the registry crosses devices inside MLS envelopes, so
// everything is normalized on receive — whitelisted fields, bounded sizes,
// and an embed whitelist so a hostile envelope can't turn a game card into
// a script injector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAMES_MAX,
  activitySrc,
  freshPresence,
  gameHost,
  normalizeGame,
  normalizeGames,
  normalizePresence,
  matchesFilter,
  sortGames,
} from '../src/lib/games.js';
import { normalizeOverview } from '../src/lib/overview.js';

test('normalizeGame keeps whitelisted, bounded fields', () => {
  const g = normalizeGame({
    id: 'g1',
    name: '  Hex Gambit  ',
    url: 'https://play.example/room',
    kind: 'activity',
    note: 'chess night',
    smuggled: 'dropped',
  });
  assert.deepEqual(g, {
    id: 'g1',
    name: 'Hex Gambit',
    url: 'https://play.example/room',
    kind: 'activity',
    note: 'chess night',
  });
});

test('activities must be embeddable: https or a same-origin path', () => {
  assert.equal(activitySrc('https://play.example/x'), 'https://play.example/x');
  assert.equal(activitySrc('/games/hexgambit.html'), '/games/hexgambit.html');
  assert.equal(activitySrc('javascript:alert(1)'), null);
  assert.equal(activitySrc('data:text/html,x'), null);
  assert.equal(activitySrc('//evil.example/x'), null);
  assert.equal(activitySrc('http://plain.example/x'), null);
  // an activity with an unembeddable url is dropped entirely
  assert.equal(normalizeGame({ id: 'g', name: 'x', url: 'javascript:alert(1)', kind: 'activity' }), null);
  // …but a server address is just a string on a card, never embedded
  const srv = normalizeGame({ id: 'g', name: 'mc', url: 'mc.example.net:25565', kind: 'server' });
  assert.equal(srv.kind, 'server');
});

test('unknown kinds fall back to activity and get the embed check', () => {
  assert.equal(normalizeGame({ id: 'g', name: 'x', url: 'not-a-url', kind: 'weird' }), null);
});

test('normalizeGames bounds the list and drops junk', () => {
  const many = Array.from({ length: GAMES_MAX + 10 }, (_, i) => ({
    id: `g${i}`,
    name: `game ${i}`,
    url: 'https://x.example',
    kind: 'activity',
  }));
  assert.equal(normalizeGames(many).length, GAMES_MAX);
  assert.deepEqual(normalizeGames([null, 'x', { id: '', name: 'a', url: 'https://x' }]), []);
  assert.deepEqual(normalizeGames('nope'), []);
});

test('games ride inside the overview payload', () => {
  const ov = normalizeOverview({
    games: [{ id: 'g1', name: 'Hex Gambit', url: 'https://play.example', kind: 'activity' }],
  });
  assert.equal(ov.games.length, 1);
  assert.equal(ov.blurb, '');
  // an overview that is only junk games is still nothing
  assert.equal(normalizeOverview({ games: [{ id: 'g', url: 'https://x' }] }), null);
});

test('gameHost names where the game actually lives', () => {
  assert.equal(gameHost({ kind: 'activity', url: 'https://play.example:8443/r/1' }), 'play.example:8443');
  assert.equal(gameHost({ kind: 'activity', url: '/games/hexgambit.html' }), 'bundled with this app');
  assert.equal(gameHost({ kind: 'server', url: 'mc.example.net:25565' }), 'mc.example.net:25565');
});

test('glyphs are kept, bounded, optional', () => {
  const g = normalizeGame({ id: 'g', name: 'x', url: 'https://x.example', glyph: ' ♞ ' });
  assert.equal(g.glyph, '♞');
  const long = normalizeGame({ id: 'g', name: 'x', url: 'https://x.example', glyph: 'abcdefgh' });
  assert.equal(long.glyph, 'abcd');
  assert.equal('glyph' in normalizeGame({ id: 'g', name: 'x', url: 'https://x.example' }), false);
});

test('presence claims are whitelisted and expire', async () => {
  const { normalizePresence, freshPresence, PRESENCE_TTL } = await import('../src/lib/games.js');
  const NOW = 1_800_000_000_000;
  const p = normalizePresence({ playing: { id: 'g1', name: 'Hex', kind: 'activity', url: 'https://evil' } }, NOW);
  assert.deepEqual(p.playing, { id: 'g1', name: 'Hex', kind: 'activity' }); // url never rides along
  assert.deepEqual(freshPresence(p, NOW + PRESENCE_TTL - 1), p.playing);
  assert.equal(freshPresence(p, NOW + PRESENCE_TTL + 1), null);
  assert.equal(normalizePresence({ playing: null }, NOW).playing, null);
  assert.equal(normalizePresence('junk', NOW).playing, null);
});

// A tiny fixture shelf plus the accessor `facts` the pure shelf rules read.
const SHELF = [
  { id: 'a', name: 'Alpha', url: 'https://a.example', kind: 'activity' },
  { id: 'b', name: 'Bravo', url: 'bravo.example:25565', kind: 'server' },
  { id: 'c', name: 'Charlie', url: 'https://c.example', kind: 'activity' },
];
const facts = ({ live = [], fav = [], played = {} } = {}) => ({
  isLive: (id) => live.includes(id),
  isFav: (id) => fav.includes(id),
  playedAt: (id) => played[id] ?? null,
});

test('matchesFilter routes each chip to the right games', () => {
  const f = facts({ live: ['a'], fav: ['c'], played: { b: 1000 } });
  const ids = (filter) => SHELF.filter((g) => matchesFilter(g, filter, f)).map((g) => g.id);
  assert.deepEqual(ids('all'), ['a', 'b', 'c']);
  assert.deepEqual(ids('live'), ['a']);
  assert.deepEqual(ids('favorites'), ['c']);
  assert.deepEqual(ids('recent'), ['b']); // has a played timestamp
  assert.deepEqual(ids('web'), ['a', 'c']); // activities only
  assert.deepEqual(ids('servers'), ['b']);
  assert.deepEqual(ids('unknown'), ['a', 'b', 'c']); // unknown filter shows all
});

test('sortGames orders live, then starred, then recently played, stable', () => {
  // c is live → first; b is starred → before plain a; among the rest, most
  // recently played wins, and registry order breaks a true tie.
  const f = facts({ live: ['c'], fav: ['b'], played: { a: 5000, b: 9000 } });
  assert.deepEqual(sortGames(SHELF, f).map((g) => g.id), ['c', 'b', 'a']);

  // No signal at all → registry order is preserved untouched.
  assert.deepEqual(sortGames(SHELF, facts()).map((g) => g.id), ['a', 'b', 'c']);

  // Recency separates two otherwise-equal games without disturbing the input.
  const input = SHELF.slice();
  const played = facts({ played: { a: 100, c: 900 } });
  assert.deepEqual(sortGames(input, played).map((g) => g.id), ['c', 'a', 'b']);
  assert.deepEqual(input.map((g) => g.id), ['a', 'b', 'c'], 'input array not mutated');
});

test('normalizePresence honors a sane claimed ts so replays age out', () => {
  const now = 1_000_000_000;
  const old = normalizePresence({ playing: { id: 'g', name: 'G' }, ts: now - 5 * 3600e3 }, now);
  assert.equal(old.ts, now - 5 * 3600e3, 'claimed ts kept');
  assert.equal(freshPresence(old, now), null, 'stale claim reads as expired');
  const future = normalizePresence({ playing: { id: 'g', name: 'G' }, ts: now + 9e9 }, now);
  assert.equal(future.ts, now, 'future claims clamp to now');
  const missing = normalizePresence({ playing: { id: 'g', name: 'G' } }, now);
  assert.equal(missing.ts, now, 'no claim falls back to receipt time');
});

test('rally claims are whitelisted and expire faster than presence', async () => {
  const { normalizeWant, freshWant, WANT_TTL } = await import('../src/lib/games.js');
  const NOW = 1_800_000_000_000;
  const w = normalizeWant({ want: { id: 'g3', name: 'Tanks', kind: 'activity', url: 'https://evil' } }, NOW);
  assert.deepEqual(w.want, { id: 'g3', name: 'Tanks', kind: 'activity' }); // url never rides along
  assert.deepEqual(freshWant(w, NOW + WANT_TTL - 1), w.want);
  assert.equal(freshWant(w, NOW + WANT_TTL + 1), null, 'a stale rally reads as expired');
  assert.equal(normalizeWant({ want: null }, NOW).want, null, 'a stand-down carries no game');
  assert.equal(normalizeWant('junk', NOW).want, null);
  // Honors a sane claimed ts (replays age from when the rally was made) and
  // clamps a future ts to now — same discipline as presence.
  const old = normalizeWant({ want: { id: 'g', name: 'G' }, ts: NOW - WANT_TTL - 1 }, NOW);
  assert.equal(freshWant(old, NOW), null, 'replayed rally ages out from its claimed ts');
  const future = normalizeWant({ want: { id: 'g', name: 'G' }, ts: NOW + 9e9 }, NOW);
  assert.equal(future.ts, NOW, 'future rally clamps to now');
});
