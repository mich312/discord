// Game-shelf rules: the registry crosses devices inside MLS envelopes, so
// everything is normalized on receive — whitelisted fields, bounded sizes,
// and an embed whitelist so a hostile envelope can't turn a game card into
// a script injector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES_MAX, activitySrc, gameHost, normalizeGame, normalizeGames } from '../src/lib/games.js';
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
