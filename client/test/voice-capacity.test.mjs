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

/* -------------------------------------------------- hiding your address -- */

import { hasTurn, loadRelayOnly, peerConfig, saveRelayOnly, RELAY_ONLY_KEY } from '../src/lib/voice.js';

function fakeStorage(seed = {}, { fail = false } = {}) {
  const map = new Map(Object.entries(seed));
  const guard = () => {
    if (fail) throw new DOMException('denied');
  };
  return {
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), void map.set(k, v)),
    removeItem: (k) => (guard(), void map.delete(k)),
    has: (k) => map.has(k),
  };
}

test('by default nothing constrains ICE, so calls connect as they always did', () => {
  const cfg = peerConfig([{ urls: 'stun:example' }], false);
  assert.equal(cfg.iceTransportPolicy, undefined);
  assert.deepEqual(cfg.iceServers, [{ urls: 'stun:example' }]);
});

test('hiding your address restricts ICE to relay candidates', () => {
  // Without this the browser offers host and reflexive candidates, which is
  // exactly how every peer learns your address.
  const cfg = peerConfig([{ urls: 'turn:example' }], true);
  assert.equal(cfg.iceTransportPolicy, 'relay');
});

test('the policy still applies when no TURN server is configured', () => {
  // Calls then fail to connect — deliberately. A privacy switch that
  // silently does nothing is worse than one that visibly does not work,
  // because only the second kind gets noticed. The UI warns separately.
  const cfg = peerConfig([{ urls: 'stun:example' }], true);
  assert.equal(cfg.iceTransportPolicy, 'relay');
});

test('a missing ICE list still yields a usable config', () => {
  assert.ok(Array.isArray(peerConfig(undefined, false).iceServers));
});

test('TURN is detected however the server list is shaped', () => {
  assert.equal(hasTurn([{ urls: 'turn:t.example:3478' }]), true);
  assert.equal(hasTurn([{ urls: 'turns:t.example:5349' }]), true, 'TLS TURN counts');
  assert.equal(hasTurn([{ urls: ['stun:s.example', 'turn:t.example'] }]), true, 'array form');
  assert.equal(hasTurn([{ urls: ' TURN:t.example ' }]), true, 'case and padding');
});

test('STUN alone is not TURN', () => {
  // The distinction is the whole point: STUN discovers your address, TURN
  // relays so nobody learns it.
  assert.equal(hasTurn([{ urls: 'stun:s.example' }]), false);
  assert.equal(hasTurn([]), false);
  assert.equal(hasTurn(undefined), false);
  assert.equal(hasTurn([{}, { urls: null }, null]), false, 'malformed entries are not TURN');
});

test('the preference round-trips and defaults to off', () => {
  const s = fakeStorage();
  assert.equal(loadRelayOnly(s), false, 'off unless chosen');
  saveRelayOnly(true, s);
  assert.equal(loadRelayOnly(s), true);
  saveRelayOnly(false, s);
  assert.equal(s.has(RELAY_ONLY_KEY), false, 'turning it off clears the key');
});

test('unreadable storage leaves it off rather than throwing', () => {
  assert.equal(loadRelayOnly(fakeStorage({}, { fail: true })), false);
  assert.equal(saveRelayOnly(true, fakeStorage({}, { fail: true })), false);
  assert.equal(loadRelayOnly(undefined), false);
});
