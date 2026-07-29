// Channel-log crypto on plain Node (`node --test`): the AES-GCM round-trip,
// tamper rejection, what an entry's signature actually covers, the backfill
// dedup fingerprint, and the identity-derived backup key's determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  deriveBackupKey,
  entrySigningBytes,
  generateHistoryId,
  generateHistoryKey,
  messageFingerprint,
  openBackup,
  openLogEntry,
  sealBackup,
  sealLogEntry,
  verifyEntries,
} from '../src/lib/history.js';
import { b64 } from '../src/lib/relay.js';

/** A signer whose "signature" is the bytes it was asked to sign, so a test
    can assert on exactly what the signature covers. */
const echoSign = async (bytes) => bytes;
/** What the signer was handed, recovered from a sealed entry. */
async function signedBytes(key, sealed) {
  return new TextDecoder().decode(b64.dec((await openLogEntry(key, sealed)).sig));
}

test('log entries round-trip and reject the wrong key', async () => {
  const key = generateHistoryKey();
  const entry = { k: 'chat', sender: 'alice', text: 'hello from the past', ts: 1700000000000 };
  const sealed = await sealLogEntry(key, 'g1', 'h1', entry, echoSign);
  const opened = await openLogEntry(key, sealed);
  assert.equal(opened.text, entry.text);
  assert.equal(opened.sender, 'alice');
  assert.equal(opened.v, 1, 'entries carry their wire version');
  assert.ok(opened.sig, 'and a signature');

  // Ciphertext differs per call (fresh IV), still opens.
  const again = await sealLogEntry(key, 'g1', 'h1', entry, echoSign);
  assert.notEqual(sealed, again);

  // A different channel's key must not open it (AES-GCM authenticates).
  await assert.rejects(openLogEntry(generateHistoryKey(), sealed));
});

test('the signature covers the entry and where it lives', async () => {
  // Binding the circle and log id in is what stops a valid entry being
  // lifted out of one channel's log and replayed into another's by someone
  // who holds both room keys.
  const key = generateHistoryKey();
  const entry = { k: 'chat', sender: 'alice', ts: 5, text: 'hi' };
  const here = await signedBytes(key, await sealLogEntry(key, 'g1', 'h1', entry, echoSign));
  const elsewhere = await signedBytes(key, await sealLogEntry(key, 'g1', 'h2', entry, echoSign));
  const otherCircle = await signedBytes(key, await sealLogEntry(key, 'g2', 'h1', entry, echoSign));
  assert.notEqual(here, elsewhere, 'a different log signs different bytes');
  assert.notEqual(here, otherCircle, 'so does a different circle');

  // Every field of the entry is covered, and the signature itself is not.
  const bytes = new TextDecoder().decode(entrySigningBytes('g1', 'h1', { ...entry, v: 1 }));
  assert.equal(bytes, here);
  assert.equal(
    new TextDecoder().decode(entrySigningBytes('g1', 'h1', { ...entry, v: 1, sig: 'anything' })),
    bytes,
    'the signature is excluded from what it signs'
  );
  assert.notEqual(
    new TextDecoder().decode(entrySigningBytes('g1', 'h1', { ...entry, v: 1, text: 'ho' })),
    bytes,
    'changing the body changes the bytes'
  );
  assert.notEqual(
    new TextDecoder().decode(entrySigningBytes('g1', 'h1', { ...entry, v: 1, sender: 'mallory' })),
    bytes,
    'and so does claiming a different author'
  );
});

test('canonical JSON does not depend on key order', async () => {
  // Two clients building the same entry must sign identical bytes, however
  // their object literals were written.
  assert.equal(canonicalJson({ a: 1, b: [2, { d: 4, c: 3 }] }), canonicalJson({ b: [2, { c: 3, d: 4 }], a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }), 'absent and undefined agree');
  assert.equal(canonicalJson(null), 'null');
});

test('verification separates unsigned, unattributable, genuine and forged', async () => {
  const keys = { alice: b64.enc(new Uint8Array(32)) };
  const entries = [
    { sender: 'alice', ts: 1, text: 'from before signatures existed' },
    { sender: 'stranger', ts: 2, text: 'signed', sig: b64.enc(new Uint8Array(64)) },
    { sender: 'alice', ts: 3, text: 'genuine', sig: b64.enc(new Uint8Array(64)) },
    { sender: 'alice', ts: 4, text: 'forged', sig: b64.enc(new Uint8Array(64)) },
  ];
  // Only the checks that reach the verifier are the ones we hold a key for.
  const verify = async (items) => {
    assert.equal(items.length, 2, 'no key means no check to make');
    return [true, false];
  };
  assert.deepEqual(await verifyEntries('g1', 'h1', entries, keys, verify), [
    'unsigned',
    'unknown',
    'signed',
    'forged',
  ]);
});

test('file entries carry the attachment descriptor', async () => {
  const key = generateHistoryKey();
  const entry = {
    k: 'file',
    sender: 'bob',
    ts: 5,
    file: { name: 'x.png', size: 10, mime: 'image/png', blob: 'abc', key: 'k' },
  };
  const opened = await openLogEntry(key, await sealLogEntry(key, 'g1', 'h1', entry, echoSign));
  assert.deepEqual(opened.file, entry.file);
});

test('fingerprints dedup by content, distinguish text and files', () => {
  const a = { sender: 'alice', ts: 1, text: 'hi' };
  assert.equal(messageFingerprint(a), messageFingerprint({ ...a }));
  assert.notEqual(messageFingerprint(a), messageFingerprint({ ...a, ts: 2 }));
  assert.notEqual(messageFingerprint(a), messageFingerprint({ ...a, sender: 'bob' }));
  assert.notEqual(messageFingerprint(a), messageFingerprint({ ...a, text: 'ho' }));
  const f = { sender: 'alice', ts: 1, file: { blob: 'hi' } };
  assert.notEqual(messageFingerprint(a), messageFingerprint(f), 'file "hi" ≠ text "hi"');
});

test('backup key is deterministic per identity and opens only its own blob', async () => {
  const identity = new TextEncoder().encode('{"v":1,"name":"alice","signer":"…"}');
  const k1 = await deriveBackupKey(identity);
  const k2 = await deriveBackupKey(identity);
  assert.deepEqual(k1, k2, 'same identity bytes -> same key on any device');
  assert.equal(k1.length, 32);

  const backup = { v: 1, servers: [{ id: 'g1', name: 'club', channels: ['general'] }] };
  const sealed = await sealBackup(identity, backup);
  assert.deepEqual(await openBackup(identity, sealed), backup);

  const other = new TextEncoder().encode('{"v":1,"name":"eve","signer":"…"}');
  await assert.rejects(openBackup(other, sealed), 'another identity must not decrypt');
});

test('history ids are opaque and collision-resistant enough', () => {
  const ids = new Set(Array.from({ length: 1000 }, generateHistoryId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, 'url-safe, no padding');
});
