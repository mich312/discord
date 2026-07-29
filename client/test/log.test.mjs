// The channel-log fold: what a page of relay entries means once it has been
// decrypted and its signatures checked. This is where "may this entry
// rewrite that line" is decided, so it is worth exercising from plain
// objects rather than only through a controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries,
  addLocalEntry,
  addSystemMessage,
  createChannelLog,
  entryToMessage,
  messageId,
  pruneLog,
  renderLog,
} from '../src/lib/log.js';

const ctx = { server: 'srv', channel: 'general' };
const chat = (sender, ts, text) => ({ v: 1, k: 'chat', sender, ts, text });

/** Fold a list of `[entry, auth?]` at consecutive seqs. */
function fold(entries) {
  const log = createChannelLog();
  addEntries(
    log,
    entries.map(([entry, auth = 'signed'], i) => ({ seq: i + 1, entry, auth })),
    ctx
  );
  return { log, shown: renderLog(log) };
}

test('content entries become messages, ordered by their author timestamp', () => {
  const { shown } = fold([
    [chat('bob', 300, 'third')],
    [chat('alice', 100, 'first')],
    [chat('alice', 200, 'second')],
  ]);
  assert.deepEqual(shown.map((m) => m.text), ['first', 'second', 'third']);
  assert.equal(shown[0].server, 'srv');
  assert.equal(shown[0].channel, 'general');
});

test('an entry cannot say where it lands or dress itself up as a notice', () => {
  // Whoever holds the room key can write any JSON they like into the log.
  const m = entryToMessage(
    {
      sender: 'mallory',
      ts: 1,
      text: 'hi',
      server: 'elsewhere',
      channel: 'admin',
      system: true,
      deleted: true,
      auth: 'signed',
      reacts: { '🎉': ['everyone'] },
    },
    { server: 'srv', channel: 'general', auth: 'unknown', seq: 1 }
  );
  assert.equal(m.server, 'srv');
  assert.equal(m.channel, 'general');
  assert.equal(m.system, undefined, 'cannot forge a system chip');
  assert.equal(m.deleted, undefined);
  assert.equal(m.reacts, undefined);
  assert.equal(m.auth, 'unknown', 'the verdict comes from verification, not the payload');
});

test('an edit applies only to its own author’s line', () => {
  const { shown } = fold([
    [chat('alice', 100, 'original')],
    [{ v: 1, k: 'edit', sender: 'mallory', ts: 150, to: { ts: 100 }, text: 'hijacked' }],
    [{ v: 1, k: 'edit', sender: 'alice', ts: 200, to: { ts: 100 }, text: 'fixed' }],
  ]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, 'fixed', 'the author’s edit lands; the stranger’s misses');
  assert.equal(shown[0].edited, true);
});

test('the last edit wins, in relay order rather than arrival order', () => {
  const log = createChannelLog();
  // The later edit is folded in first — a page can arrive out of order.
  addEntries(log, [{ seq: 3, entry: { v: 1, k: 'edit', sender: 'alice', ts: 300, to: { ts: 100 }, text: 'third' }, auth: 'signed' }], ctx);
  addEntries(log, [{ seq: 2, entry: { v: 1, k: 'edit', sender: 'alice', ts: 200, to: { ts: 100 }, text: 'second' }, auth: 'signed' }], ctx);
  addEntries(log, [{ seq: 1, entry: chat('alice', 100, 'first'), auth: 'signed' }], ctx);
  assert.equal(renderLog(log)[0].text, 'third');
});

test('an edit that arrives before its target still lands when the target does', () => {
  // Paging backwards: the newest page carries the edit, the older page the
  // line it edits. Replaying rather than patching is what makes this work.
  const log = createChannelLog();
  addEntries(log, [{ seq: 9, entry: { v: 1, k: 'edit', sender: 'alice', ts: 900, to: { ts: 100 }, text: 'edited' }, auth: 'signed' }], ctx);
  assert.deepEqual(renderLog(log), []);
  addEntries(log, [{ seq: 1, entry: chat('alice', 100, 'original'), auth: 'signed' }], ctx);
  assert.equal(renderLog(log)[0].text, 'edited');
});

test('a delete tombstones the line and takes its body and reactions with it', () => {
  const { shown } = fold([
    [chat('alice', 100, 'oops')],
    [{ v: 1, k: 'react', sender: 'bob', ts: 150, to: { sender: 'alice', ts: 100 }, emo: '👍', op: 'add' }],
    [{ v: 1, k: 'del', sender: 'alice', ts: 200, to: { ts: 100 } }],
  ]);
  assert.equal(shown.length, 1, 'the line keeps its place so a reply still points somewhere');
  assert.equal(shown[0].deleted, true);
  assert.equal(shown[0].text, undefined);
  assert.equal(shown[0].reacts, undefined);
});

test('a reaction is cast in the name of whoever signed it, and toggles off', () => {
  const { shown } = fold([
    [chat('alice', 100, 'hi')],
    [{ v: 1, k: 'react', sender: 'bob', ts: 110, to: { sender: 'alice', ts: 100 }, emo: '👍', op: 'add' }],
    [{ v: 1, k: 'react', sender: 'carol', ts: 120, to: { sender: 'alice', ts: 100 }, emo: '👍', op: 'add' }],
    [{ v: 1, k: 'react', sender: 'bob', ts: 130, to: { sender: 'alice', ts: 100 }, emo: '👍', op: 'del' }],
  ]);
  assert.deepEqual(shown[0].reacts, { '👍': ['carol'] });
});

test('one line cannot be grown without bound by reactions', () => {
  const entries = [[chat('alice', 100, 'hi')]];
  for (let i = 0; i < 30; i++) {
    entries.push([
      { v: 1, k: 'react', sender: 'bob', ts: 200 + i, to: { sender: 'alice', ts: 100 }, emo: `e${i}`, op: 'add' },
    ]);
  }
  const { shown } = fold(entries);
  assert.equal(Object.keys(shown[0].reacts).length, 8, 'capped at REACT_MAX distinct emoji');
});

test('a forged entry is dropped, an unattributable one is kept and flagged', () => {
  const { shown } = fold([
    [chat('alice', 100, 'genuine'), 'signed'],
    [chat('alice', 200, 'forged in her name'), 'forged'],
    [{ sender: 'alice', ts: 300, text: 'from before signatures' }, 'unsigned'],
  ]);
  assert.deepEqual(shown.map((m) => m.text), ['genuine', 'from before signatures']);
  assert.deepEqual(shown.map((m) => m.auth), ['signed', 'unsigned']);
});

test('an unverified mutation never takes effect', () => {
  // There is no legacy of unsigned mutations to stay compatible with, and
  // they are exactly what a room-key holder would forge.
  for (const auth of ['unsigned', 'unknown']) {
    const { shown } = fold([
      [chat('alice', 100, 'original'), 'signed'],
      [{ v: 1, k: 'edit', sender: 'alice', ts: 200, to: { ts: 100 }, text: 'rewritten' }, auth],
      [{ v: 1, k: 'del', sender: 'alice', ts: 300, to: { ts: 100 } }, auth],
    ]);
    assert.equal(shown[0].text, 'original', `${auth} mutations are inert`);
    assert.equal(shown[0].deleted, undefined);
  }
});

test('the relay copy supersedes the local echo, never the other way round', () => {
  const log = createChannelLog();
  addLocalEntry(log, chat('alice', 100, 'hello'), ctx);
  assert.equal(renderLog(log)[0].seq, undefined, 'a local echo has no relay seq yet');

  addEntries(log, [{ seq: 4, entry: chat('alice', 100, 'hello'), auth: 'signed' }], ctx);
  let shown = renderLog(log);
  assert.equal(shown.length, 1, 'one line, not two');
  assert.equal(shown[0].seq, 4, 'and it carries the seq a redaction can name');

  // A second delivery of the same entry changes nothing.
  addEntries(log, [{ seq: 4, entry: chat('alice', 100, 'hello'), auth: 'signed' }], ctx);
  assert.equal(renderLog(log).length, 1);
});

test('the same mutation from the live path and the log is one event', () => {
  const log = createChannelLog();
  addEntries(log, [{ seq: 1, entry: chat('alice', 100, 'hi'), auth: 'signed' }], ctx);
  const edit = { v: 1, k: 'edit', sender: 'alice', ts: 500, to: { ts: 100 }, text: 'edited' };
  addLocalEntry(log, edit, ctx);
  addEntries(log, [{ seq: 2, entry: edit, auth: 'signed' }], ctx);
  assert.equal(log.mutations.size, 1, 'keyed on (author, kind, its own ts)');
  assert.equal(renderLog(log)[0].text, 'edited');
});

test('cursors track the page range, and system notices stay out of the log', () => {
  const log = createChannelLog();
  addEntries(
    log,
    [
      { seq: 5, entry: chat('alice', 100, 'a'), auth: 'signed' },
      { seq: 9, entry: chat('alice', 200, 'b'), auth: 'signed' },
    ],
    ctx
  );
  assert.equal(log.oldest, 5);
  assert.equal(log.newest, 9);

  addSystemMessage(log, { ...ctx, text: 'bob joined', ts: 150 });
  const shown = renderLog(log);
  assert.equal(shown.length, 3);
  assert.equal(shown[1].system, true, 'the notice sits in time order');
  assert.equal(shown[1].sender, '');
});

test('retention drops what is past the cutoff, mutations included', () => {
  const log = createChannelLog();
  addEntries(
    log,
    [
      { seq: 1, entry: chat('alice', 100, 'old'), auth: 'signed' },
      { seq: 2, entry: chat('alice', 500, 'recent'), auth: 'signed' },
      { seq: 3, entry: { v: 1, k: 'edit', sender: 'alice', ts: 110, to: { ts: 100 }, text: 'x' }, auth: 'signed' },
    ],
    ctx
  );
  assert.equal(pruneLog(log, 400), 1);
  assert.deepEqual(renderLog(log).map((m) => m.text), ['recent']);
  assert.equal(log.mutations.size, 0, 'a mutation for a dropped line goes with it');
});

test('messageId is the identity two delivery paths agree on', () => {
  assert.equal(messageId('alice', 100), messageId('alice', 100));
  assert.notEqual(messageId('alice', 100), messageId('alice', 101));
  assert.notEqual(messageId('alice', 100), messageId('bob', 100));
});
