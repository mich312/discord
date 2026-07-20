// A message's timestamp is the sender's, carried on the wire, so a live copy
// and its kept-history copy dedupe (both key on ts) and every member orders
// the message identically. These guard that convergence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageTs } from '../src/lib/controller.js';
import { messageFingerprint } from '../src/lib/history.js';

const NOW = 1_800_000_000_000;

test('messageTs keeps a finite positive sender timestamp', () => {
  assert.equal(messageTs(NOW, NOW + 5000), NOW); // sender clock wins, not receiver's
  assert.equal(messageTs(NOW - 86_400_000, NOW), NOW - 86_400_000);
});

test('messageTs falls back to the local clock for a missing or junk ts', () => {
  assert.equal(messageTs(undefined, NOW), NOW); // older sender sent no ts
  assert.equal(messageTs(null, NOW), NOW);
  assert.equal(messageTs('soon', NOW), NOW);
  assert.equal(messageTs(-1, NOW), NOW);
  assert.equal(messageTs(0, NOW), NOW);
});

test('live and history copies of a message share a fingerprint', () => {
  // The bug: a recipient stamped its own receive-time ts on the live copy
  // while the history log carried the sender's ts, so the same message failed
  // to dedupe and was restored a second time. With the sender's ts on the
  // wire, both copies converge.
  const sender = 'alice';
  const wireTs = NOW; // what alice put on the envelope and sealed into history
  const live = { sender, ts: messageTs(wireTs, NOW + 1234), text: 'hi' }; // receiver clock skewed
  const history = { sender, ts: wireTs, text: 'hi' };
  assert.equal(messageFingerprint(live), messageFingerprint(history));
});

test('two recipients with skewed clocks order a message identically', () => {
  const wireTs = NOW;
  const atBob = messageTs(wireTs, NOW + 9000);
  const atCarol = messageTs(wireTs, NOW - 4000);
  assert.equal(atBob, atCarol);
});
