// There was no message search at all, and no copy explaining why — which
// reads as an oversight rather than as the deliberate cost of a relay that
// cannot index ciphertext. These cover the matching, ranking and snippet
// rules; the IndexedDB scan around them lives in the controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_QUERY,
  SEARCH_LIMIT,
  matchesTerms,
  parseQuery,
  rankHits,
  searchableText,
  snippet,
} from '../src/lib/search.js';

const row = (ts, text, extra = {}) => ({
  server: 'srv',
  channel: 'general',
  message: { ts, sender: 'bob', text, ...extra },
});

/* ---------------------------------------------------------- parseQuery -- */

test('a query splits into terms on whitespace, case-folded', () => {
  assert.deepEqual(parseQuery('  Hello   World '), ['hello', 'world']);
});

test('a quoted run stays one term', () => {
  // Without phrases there is no way to find "pull request" without also
  // matching every line holding both words a paragraph apart.
  assert.deepEqual(parseQuery('"pull request" ci'), ['pull request', 'ci']);
});

test('an empty or unquoted-empty query yields no terms', () => {
  assert.deepEqual(parseQuery(''), []);
  assert.deepEqual(parseQuery('   '), []);
  assert.deepEqual(parseQuery('""'), []);
  assert.deepEqual(parseQuery(undefined), []);
});

/* -------------------------------------------------------- matchesTerms -- */

test('every term must appear — AND, not OR', () => {
  // With OR, typing a second word returns strictly more results, which is
  // the opposite of what adding a word means.
  assert.equal(matchesTerms('deploy the relay', ['deploy', 'relay']), true);
  assert.equal(matchesTerms('deploy the client', ['deploy', 'relay']), false);
});

test('matching ignores case and works mid-word', () => {
  assert.equal(matchesTerms('Redeployment', ['deploy']), true);
});

test('no terms matches nothing rather than everything', () => {
  assert.equal(matchesTerms('anything', []), false);
});

test('a message with no text is not a match', () => {
  assert.equal(matchesTerms(undefined, ['a']), false);
});

/* ------------------------------------------------------ searchableText -- */

test('attachments are findable by filename', () => {
  // The bytes are opaque, but the name is the only handle anyone remembers
  // a file by.
  assert.equal(searchableText({ file: { name: 'budget.xlsx' } }), 'budget.xlsx');
  assert.equal(searchableText({ text: 'see', file: { name: 'a.png' } }), 'see a.png');
  assert.equal(searchableText({}), '');
});

/* ------------------------------------------------------------- snippet -- */

test('the snippet centres on the match and marks it', () => {
  const s = snippet('the quick brown fox jumps', ['brown']);
  assert.equal(s.match, 'brown');
  assert.match(s.before, /quick $/);
  assert.match(s.after, /^ fox/);
});

test('a long line is trimmed on both sides with ellipses', () => {
  const s = snippet(`${'a '.repeat(200)}needle${' b'.repeat(200)}`, ['needle'], 20);
  assert.equal(s.match, 'needle');
  assert.ok(s.before.startsWith('…'), 'trimmed at the head');
  assert.ok(s.after.endsWith('…'), 'trimmed at the tail');
  assert.ok(s.before.length + s.after.length < 60, 'stays roughly within the width');
});

test('a match at the very start gets no leading ellipsis', () => {
  const s = snippet('needle in a haystack', ['needle']);
  assert.equal(s.before, '');
});

test('whitespace is collapsed so a pasted block stays one line', () => {
  const s = snippet('one\n\n  two   three', ['two']);
  assert.equal(`${s.before}${s.match}${s.after}`.includes('\n'), false);
  assert.equal(s.match, 'two');
});

test('the longest term starting at the hit is the one marked', () => {
  // "de" and "deploy" both start at 0; marking "de" would highlight less
  // than the reader typed.
  const s = snippet('deploy now', ['de', 'deploy']);
  assert.equal(s.match, 'deploy');
});

test('a snippet with no match shows the head of the line rather than nothing', () => {
  const s = snippet('nothing relevant here', ['zebra']);
  assert.equal(s.match, '');
  assert.ok(s.before.length > 0);
});

/* ------------------------------------------------------------ rankHits -- */

test('results are newest first', () => {
  // "The most recent time this was said" is what people reconstruct.
  const { hits } = rankHits([row(100, 'ping'), row(300, 'ping'), row(200, 'ping')], 'ping');
  assert.deepEqual(hits.map((h) => h.ts), [300, 200, 100]);
});

test('a query shorter than the minimum searches nothing', () => {
  // A one-character scan of every message on the device matches everything
  // and costs the most.
  assert.equal(MIN_QUERY, 2);
  assert.deepEqual(rankHits([row(1, 'aaa')], 'a').hits, []);
  assert.equal(rankHits([row(1, 'aaa')], 'aa').hits.length, 1);
});

test('system chips never surface as results', () => {
  // Same rule the unread counts use: chrome, not conversation.
  assert.deepEqual(rankHits([row(1, 'carol joined', { system: true })], 'carol').hits, []);
});

test('a hit carries where it was said, not just what', () => {
  const [hit] = rankHits([row(500, 'the relay is down')], 'relay').hits;
  assert.equal(hit.server, 'srv');
  assert.equal(hit.channel, 'general');
  assert.equal(hit.sender, 'bob');
  assert.equal(hit.ts, 500);
  assert.equal(hit.snippet.match, 'relay');
});

test('an unparseable timestamp sorts last rather than throwing', () => {
  const { hits } = rankHits([row('later', 'ping'), row(50, 'ping')], 'ping');
  assert.deepEqual(hits.map((h) => h.ts), [50, 0]);
});

test('the list is capped, and says so', () => {
  const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => row(i + 1, 'ping'));
  const { hits, truncated } = rankHits(many, 'ping');
  assert.equal(hits.length, SEARCH_LIMIT);
  assert.equal(truncated, true, 'the UI must be able to say the list was cut');
  // Capping after sorting, not before: the newest matches are the ones kept.
  assert.equal(hits[0].ts, SEARCH_LIMIT + 5);
});

test('a result set inside the cap is not reported as truncated', () => {
  assert.equal(rankHits([row(1, 'ping')], 'ping').truncated, false);
});

test('an explicit smaller limit is honoured', () => {
  const { hits, truncated } = rankHits([row(1, 'a b'), row(2, 'a b')], 'a b', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(truncated, true);
});

test('malformed rows are skipped rather than crashing the search', () => {
  const { hits } = rankHits([null, {}, { message: null }, row(9, 'ping')], 'ping');
  assert.equal(hits.length, 1);
});

test('no rows at all is an empty result, not an error', () => {
  assert.deepEqual(rankHits(undefined, 'ping'), { hits: [], truncated: false });
});
