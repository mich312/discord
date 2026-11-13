// One tab at a time: two tabs sharing one ratchet silently broke sending
// from one of them and receiving in the other. The lock is the only thing
// standing between a second tab and that, so its handover rules are pinned
// here against a fake LockManager that follows the real one's semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLock } from '../src/lib/session-lock.js';

/** A LockManager for one lock name, shared by every "tab" built on it. */
function fakeLocks() {
  let holder = null; // { abort }
  const queue = [];
  const grant = (callback, resolve, reject) => {
    const me = { abort: (e) => reject(e) };
    holder = me;
    Promise.resolve(callback({ name: 'lock' })).then(
      (v) => {
        if (holder === me) holder = null;
        resolve(v);
        const next = queue.shift();
        if (next) grant(next.callback, next.resolve, next.reject);
      },
      reject
    );
  };
  return {
    request(_name, optionsOrCb, maybeCb) {
      const options = typeof optionsOrCb === 'function' ? {} : optionsOrCb;
      const callback = maybeCb ?? optionsOrCb;
      return new Promise((resolve, reject) => {
        if (options.steal) {
          const old = holder;
          holder = null;
          old?.abort(new Error('AbortError: the lock was stolen'));
          return grant(callback, resolve, reject);
        }
        if (!holder) return grant(callback, resolve, reject);
        if (options.ifAvailable) return resolve(callback(null));
        const entry = { callback, resolve, reject };
        queue.push(entry);
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error('AbortError'));
        });
      });
    },
  };
}

/** BroadcastChannel across the fake tabs: everyone but the poster hears it. */
function fakeChannels() {
  const all = new Set();
  return class {
    constructor() {
      all.add(this);
    }
    postMessage(data) {
      for (const c of all) if (c !== this) queueMicrotask(() => c.onmessage?.({ data }));
    }
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('the first tab gets the session, and a second is told it is taken', async () => {
  const locks = fakeLocks();
  const Channel = fakeChannels();
  const first = new SessionLock({ locks, Channel });
  const second = new SessionLock({ locks, Channel });
  assert.equal(await first.tryAcquire(), true);
  assert.equal(await second.tryAcquire(), false, 'never two at once');
  assert.equal(second.held, false);
});

test('taking over makes the holder stop BEFORE the new tab starts', async () => {
  // The order is the point: the old tab must be done touching the ratchet
  // before the new one loads it.
  const locks = fakeLocks();
  const Channel = fakeChannels();
  const order = [];
  const first = new SessionLock({
    locks,
    Channel,
    onSuperseded: async () => {
      await tick(10);
      order.push('first stopped');
    },
  });
  const second = new SessionLock({ locks, Channel });
  await first.tryAcquire();
  await second.tryAcquire();
  await second.takeOver();
  order.push('second started');
  assert.deepEqual(order, ['first stopped', 'second started']);
  assert.equal(first.held, false);
  assert.equal(second.held, true);
});

test('a holder that never answers has the session taken from it', async () => {
  const locks = fakeLocks();
  let stopped = false;
  // No channel between them: the first tab is frozen and hears nothing.
  const first = new SessionLock({ locks, Channel: null, onSuperseded: () => void (stopped = true) });
  const second = new SessionLock({ locks, Channel: null, handoverMs: 20 });
  await first.tryAcquire();
  assert.equal(await second.takeOver(), true);
  assert.equal(second.held, true);
  await tick();
  assert.equal(stopped, true, 'and it is told so when it wakes');
  assert.equal(first.held, false);
});

test('the session can be handed back again', async () => {
  const locks = fakeLocks();
  const Channel = fakeChannels();
  const first = new SessionLock({ locks, Channel });
  const second = new SessionLock({ locks, Channel });
  await first.tryAcquire();
  await second.takeOver();
  await first.takeOver();
  assert.equal(first.held, true);
  assert.equal(second.held, false);
});

test('a browser without Web Locks runs unguarded rather than not at all', async () => {
  const lock = new SessionLock({ locks: undefined, Channel: undefined });
  assert.equal(lock.supported, false);
  assert.equal(await lock.tryAcquire(), true);
  assert.equal(await lock.takeOver(), true);
});
