// The crypto worker's failure paths. A worker that never starts used to
// leave every call pending forever: boot() awaited a promise nothing would
// ever settle, so the app sat on the splash screen with no error, no toast
// and no way back. That is unreportable from the user's side, which is why
// these are worth pinning even though the happy path is exercised constantly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrypto } from '../src/lib/rpc.js';

/** A Worker stand-in whose lifecycle the test drives. */
class FakeWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.posted = [];
    FakeWorker.last = this;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  /** Answer a posted call the way the real worker does. */
  reply(id, body) {
    this.onmessage({ data: { id, ...body } });
  }
}

const crypto = () => createCrypto({ WorkerImpl: FakeWorker });

test('a call is answered by id, so overlapping calls do not cross', async () => {
  const call = crypto();
  const w = FakeWorker.last;
  const first = call('boot', { identity: 1 });
  const second = call('send', { text: 'hi' });

  // Answered out of order on purpose: the RPC layer keys on the id, and
  // getting that wrong would hand one caller another's plaintext.
  w.reply(w.posted[1].id, { ok: true, result: 'second-result' });
  w.reply(w.posted[0].id, { ok: true, result: 'first-result' });

  assert.equal(await second, 'second-result');
  assert.equal(await first, 'first-result');
});

test('the command and its arguments reach the worker', async () => {
  const call = crypto();
  const w = FakeWorker.last;
  call('send', { group: 'g1', text: 'hello' });
  assert.equal(w.posted[0].cmd, 'send');
  assert.equal(w.posted[0].group, 'g1');
  assert.equal(w.posted[0].text, 'hello');
  assert.ok(w.posted[0].id, 'and it is tagged with an id');
});

test('an error reply rejects that call and nothing else', async () => {
  const call = crypto();
  const w = FakeWorker.last;
  const bad = call('boot');
  const good = call('send');
  w.reply(w.posted[0].id, { ok: false, error: 'no identity' });
  w.reply(w.posted[1].id, { ok: true, result: 'fine' });
  await assert.rejects(() => bad, /no identity/);
  assert.equal(await good, 'fine');
});

test('a worker that fails to start rejects every in-flight call', async () => {
  // The regression this exists for. Without it these promises never settle.
  const call = crypto();
  const w = FakeWorker.last;
  const pending = [call('boot'), call('send')];
  w.onerror({ message: 'failed to fetch crypto_core.js' });
  for (const p of pending) {
    await assert.rejects(() => p, /encryption worker failed to start/);
  }
});

test('the startup error names the underlying cause', async () => {
  // "something went wrong" is not actionable; the wasm fetch failure is.
  const call = crypto();
  const p = call('boot');
  FakeWorker.last.onerror({ message: 'failed to fetch crypto_core_bg.wasm' });
  await assert.rejects(() => p, /crypto_core_bg\.wasm/);
});

test('a startup failure with no message still produces a usable error', async () => {
  const call = crypto();
  const p = call('boot');
  FakeWorker.last.onerror({});
  await assert.rejects(() => p, /unknown error/);
});

test('calls made AFTER the worker died fail fast rather than hanging', async () => {
  // Boot retries and later user actions both land here. Hanging is the
  // failure mode; failing is recoverable.
  const call = crypto();
  FakeWorker.last.onerror({ message: 'gone' });
  await assert.rejects(() => call('send'), /encryption worker failed to start/);
  assert.equal(
    FakeWorker.last.posted.length,
    0,
    'and nothing is posted to a worker that cannot receive it'
  );
});

test('an unreadable message from the worker is treated as fatal, not ignored', async () => {
  // messageerror fires when a module worker's static imports cannot be
  // resolved — the common real-world wasm failure.
  const call = crypto();
  const p = call('boot');
  FakeWorker.last.onmessageerror({});
  await assert.rejects(() => p, /unreadable message/);
});

test('a reply for an unknown id is ignored rather than throwing', async () => {
  // A late answer after killAll() cleared the map must not take the page down.
  const call = crypto();
  const w = FakeWorker.last;
  const p = call('boot');
  w.onerror({ message: 'dead' });
  await assert.rejects(() => p);
  assert.doesNotThrow(() => w.reply(999, { ok: true, result: 'late' }));
});

test('the worker is loaded as a module from the expected path', () => {
  // The offline shell precaches /worker.js by name; a change here without a
  // matching one there ships a PWA that cannot boot offline.
  crypto();
  assert.equal(FakeWorker.last.url, '/worker.js');
  assert.equal(FakeWorker.last.opts.type, 'module');
});
