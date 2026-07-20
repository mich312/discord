// Channel presence guard: a message for an unknown channel surfaces it, but
// a message for a channel we have seen *deleted* must never resurrect it —
// only an explicit admin re-creation may. These are the pure record-shaping
// halves of the receive path (no I/O), exercised via the prototype so they
// need no live controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/lib/controller.js';

const ensureChannel = (record, ch) => Controller.prototype.ensureChannel.call(null, record, ch);
const markDeleted = (record, ch) => Controller.prototype.markChannelDeleted.call(null, record, ch);
const clearDeleted = (record, ch) => Controller.prototype.clearChannelDeleted.call(null, record, ch);

test('ensureChannel surfaces an unknown channel for an in-flight message', () => {
  const record = { channels: ['general'] };
  ensureChannel(record, 'racing');
  assert.deepEqual(record.channels, ['general', 'racing']);
  // idempotent — a second message does not duplicate it
  ensureChannel(record, 'racing');
  assert.deepEqual(record.channels, ['general', 'racing']);
});

test('ensureChannel never surfaces a call thread as a text room', () => {
  const record = { channels: ['general'] };
  ensureChannel(record, 'voice:lounge');
  assert.deepEqual(record.channels, ['general']);
});

test('a stray message cannot resurrect a deleted channel', () => {
  // The reported bug: an admin deletes a room, then a late/replayed/reordered
  // message for it arrives and the room reappears — for that one member only.
  const record = { channels: ['general', 'photos'] };
  record.channels = record.channels.filter((c) => c !== 'photos');
  markDeleted(record, 'photos');

  ensureChannel(record, 'photos'); // the stray message lands here
  assert.deepEqual(record.channels, ['general'], 'deleted channel stayed gone');
});

test('an explicit admin re-creation lifts the tombstone', () => {
  const record = { channels: ['general'], deletedChannels: ['photos'] };
  // `chan` handler / createChannel clears the tombstone before adding
  clearDeleted(record, 'photos');
  record.channels.push('photos');
  assert.deepEqual(record.deletedChannels, []);
  // a message for the revived channel now surfaces normally
  ensureChannel(record, 'photos');
  assert.deepEqual(record.channels, ['general', 'photos']);
});

test('the tombstone list is bounded', () => {
  const record = { channels: ['general'] };
  for (let i = 0; i < Controller.DELETED_MAX + 50; i++) markDeleted(record, `ch${i}`);
  assert.equal(record.deletedChannels.length, Controller.DELETED_MAX);
  // it keeps the most recent deletions
  assert.ok(record.deletedChannels.includes(`ch${Controller.DELETED_MAX + 49}`));
  assert.ok(!record.deletedChannels.includes('ch0'));
});
