// The encryption line under a conversation, as a function of state. The
// component renders whatever encryptionNote() returns, so the rule that
// matters is pinned here: a key mismatch never reads as verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptionNote,
  uncheckedMembers,
  mismatchedMembers,
} from '../src/lib/encryption-note.js';

const circle = (over = {}) => ({
  members: ['me', 'alice', 'bob'],
  verified: [],
  mismatched: {},
  ...over,
});

test('everyone else verified: says so, with no link', () => {
  const note = encryptionNote(circle({ verified: ['alice', 'bob'] }), 'me');
  assert.equal(note.state, 'verified');
  assert.equal(note.text, 'Encrypted for 3 verified people');
  assert.equal(note.action, null);
});

test('someone unverified: counts them and links to the fix', () => {
  const note = encryptionNote(circle({ verified: ['alice'] }), 'me');
  assert.equal(note.state, 'unverified');
  assert.equal(note.text, 'Encrypted for 3 people');
  assert.equal(note.action, '1 not verified');
  assert.deepEqual(note.who, ['bob']);
});

test('alone: nobody to encrypt for or verify', () => {
  const note = encryptionNote({ members: ['me'], verified: [], mismatched: {} }, 'me');
  assert.equal(note.state, 'alone');
  assert.equal(note.text, 'Only you are here');
  assert.equal(note.action, null);
});

test('a mismatch is never shown as verified, even when everyone else is', () => {
  // The bug: a mismatched member left the unchecked list, so with the rest
  // verified the line read "verified" while a key had failed to match.
  const server = circle({ verified: ['bob'], mismatched: { alice: '111' } });
  assert.deepEqual(uncheckedMembers(server, 'me'), []);
  const note = encryptionNote(server, 'me');
  assert.equal(note.state, 'mismatch');
  assert.equal(note.text, 'alice’s key doesn’t match');
  assert.equal(note.action, 'Review');
  assert.doesNotMatch(note.text, /verified/);
});

test('a mismatch outranks unverified members', () => {
  const note = encryptionNote(circle({ mismatched: { alice: '111' } }), 'me');
  assert.equal(note.state, 'mismatch');
});

test('several mismatches are counted', () => {
  const note = encryptionNote(circle({ mismatched: { alice: '1', bob: '2' } }), 'me');
  assert.equal(note.text, '2 keys don’t match');
});

test('a mismatch for someone who has left the circle is not reported', () => {
  const server = circle({ verified: ['alice', 'bob'], mismatched: { carol: '9' } });
  assert.deepEqual(mismatchedMembers(server, 'me'), []);
  assert.equal(encryptionNote(server, 'me').state, 'verified');
});

test('your own entry never counts against you', () => {
  const server = circle({ verified: ['alice', 'bob'], mismatched: { me: '5' } });
  assert.equal(encryptionNote(server, 'me').state, 'verified');
});
