// The per-circle key directory: which identity key speaks for which handle.
// It decides whether a log entry read back from the relay can be attributed
// to its author at all, so what it does on a conflict matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyDirectory, mergeKeyDirectory } from '../src/lib/keys.js';
import { b64 } from '../src/lib/relay.js';

const key = (n) => Uint8Array.from({ length: 32 }, () => n);

test('a roster becomes a directory the backup can carry', () => {
  const record = {};
  const { changed, conflicts } = mergeKeyDirectory(record, { alice: key(1), bob: key(2) });
  assert.equal(changed, true);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(Object.keys(record.keys).sort(), ['alice', 'bob']);
  assert.equal(record.keys.alice, b64.enc(key(1)), 'stored base64 so it rides the backup as JSON');
  assert.deepEqual(keyDirectory(record), record.keys);
});

test('re-reading the same roster changes nothing', () => {
  const record = { keys: { alice: b64.enc(key(1)) } };
  const { changed } = mergeKeyDirectory(record, { alice: key(1) });
  assert.equal(changed, false, 'no needless backup rewrite on every membership change');
});

test('a member who has left keeps their key, so their old lines stay attributable', () => {
  const record = { keys: { alice: b64.enc(key(1)), departed: b64.enc(key(9)) } };
  mergeKeyDirectory(record, { alice: key(1) });
  assert.equal(record.keys.departed, b64.enc(key(9)));
});

test('a handle presenting a different key is a conflict, and the roster wins', () => {
  // This is either a key rotation, which this build does not do, or
  // substitution — the thing safety numbers exist to catch. Taking the
  // roster's answer means entries signed by the old key stop verifying,
  // which is the safe direction to fail.
  const record = { keys: { alice: b64.enc(key(1)) } };
  const { changed, conflicts } = mergeKeyDirectory(record, { alice: key(2) });
  assert.equal(changed, true);
  assert.deepEqual(conflicts, ['alice']);
  assert.equal(record.keys.alice, b64.enc(key(2)));
});

test('an empty or malformed roster entry is ignored rather than stored', () => {
  const record = { keys: { alice: b64.enc(key(1)) } };
  const { changed } = mergeKeyDirectory(record, { bob: new Uint8Array(0), '': key(3) });
  assert.equal(changed, false);
  assert.deepEqual(Object.keys(record.keys), ['alice']);
});

test('a record with no directory answers empty rather than throwing', () => {
  assert.deepEqual(keyDirectory(undefined), {});
  assert.deepEqual(keyDirectory({}), {});
});
