// Channel-history crypto helpers on plain Node (`node --test`): WebCrypto
// AES-GCM round-trips, tamper rejection, the backfill dedup fingerprint,
// and the identity-derived backup key's determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateHistoryId,
  generateHistoryKey,
  sealHistoryEntry,
  openHistoryEntry,
  messageFingerprint,
  deriveBackupKey,
  sealBackup,
  openBackup,
} from '../src/lib/history.js';

test('history entries round-trip and reject the wrong key', async () => {
  const key = generateHistoryKey();
  const entry = { sender: 'alice', text: 'hello from the past', ts: 1700000000000 };
  const sealed = await sealHistoryEntry(key, entry);
  assert.deepEqual(await openHistoryEntry(key, sealed), entry);

  // Ciphertext differs per call (fresh IV), still opens.
  const sealed2 = await sealHistoryEntry(key, entry);
  assert.notEqual(sealed, sealed2);
  assert.deepEqual(await openHistoryEntry(key, sealed2), entry);

  // A different channel's key must not open it (AES-GCM authenticates).
  await assert.rejects(openHistoryEntry(generateHistoryKey(), sealed));
});

test('file entries carry the attachment descriptor', async () => {
  const key = generateHistoryKey();
  const entry = {
    sender: 'bob',
    ts: 5,
    file: { name: 'x.png', size: 10, mime: 'image/png', blob: 'abc', key: 'k' },
  };
  const opened = await openHistoryEntry(key, await sealHistoryEntry(key, entry));
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
