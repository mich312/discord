// Calls are a full mesh — every browser holds a connection to every other —
// and there was no cap and no warning. Past roughly eight people it does not
// fail cleanly; it degrades into unusable audio while everyone blames their
// own network. These cover the ceiling and, more importantly, that a refused
// join says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MESH_LIMIT, meshFull, meshFullMessage } from '../src/lib/voice.js';

test('a call below the ceiling accepts another person', () => {
  for (let n = 0; n < MESH_LIMIT; n += 1) {
    assert.equal(meshFull(n), false, `${n} in the call should still admit one more`);
  }
});

test('a call at the ceiling is full', () => {
  // At MESH_LIMIT the joiner would be number MESH_LIMIT + 1.
  assert.equal(meshFull(MESH_LIMIT), true);
  assert.equal(meshFull(MESH_LIMIT + 5), true, 'and stays full past it');
});

test('a missing or nonsense participant count is treated as an empty call', () => {
  // The count comes from ephemeral presence, which can be absent on a fresh
  // connection. Failing open here is right: refusing the first person to
  // join because presence had not arrived yet would break calls entirely.
  for (const v of [undefined, null, NaN, 'lots']) {
    assert.equal(meshFull(v), false, `count=${String(v)}`);
  }
});

test('the ceiling matches what a mesh can actually carry', () => {
  // Not a magic number: the code comments and docs/CAPACITY.md both state
  // ~6-8 for audio-only, since each participant uploads once per peer.
  assert.ok(MESH_LIMIT >= 6 && MESH_LIMIT <= 8, `MESH_LIMIT is ${MESH_LIMIT}`);
});

test('the refusal explains itself instead of just failing', () => {
  // A bare "could not join" reads as a bug in the app rather than a
  // property of peer-to-peer calls.
  const msg = meshFullMessage();
  assert.match(msg, /full/i);
  assert.ok(msg.includes(String(MESH_LIMIT)), 'says what the limit is');
  assert.match(msg, /peer-to-peer/i, 'says why the limit exists');
});
