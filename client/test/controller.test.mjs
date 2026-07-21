// Controller regressions: optimistic send (a message must never silently
// vanish), the stale-role gate on admin envelopes (the "game hub didn't
// sync" bug), backup contents, and ephemeral presence routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/lib/controller.js';
import { b64 } from '../src/lib/relay.js';
import { openBackup } from '../src/lib/history.js';

function fakeDb() {
  const messages = [];
  return {
    messages,
    msgAdd: async (m) => messages.push({ ...m }),
    msgPatch: async (server, channel, sender, ts, patch) => {
      const i = messages.findIndex(
        (m) => !m.system && m.server === server && m.channel === channel && m.sender === sender && m.ts === ts
      );
      if (i === -1) return false;
      messages[i] = patch(messages[i]);
      return true;
    },
    msgsFor: async (server, channel) =>
      messages.filter((m) => m.server === server && m.channel === channel),
    msgsPrune: async () => 0,
    serverPut: async () => {},
    kvPut: async () => {},
    kvGet: async () => null,
  };
}

function fakeCrypto() {
  return async (cmd) => {
    if (cmd === 'send') return { blob: new Uint8Array([1, 2, 3]), epoch: 1, state: null };
    if (cmd === 'receive') throw new Error('not used in these tests');
    return {};
  };
}

function makeController({ relayHandler } = {}) {
  const dispatched = [];
  const c = new Controller({
    db: fakeDb(),
    crypto: fakeCrypto(),
    dispatch: (a) => dispatched.push(a),
    relayUrl: 'ws://test/ws',
  });
  c.me = 'alice';
  c.relay = {
    ready: true,
    requests: [],
    request(msg) {
      this.requests.push(msg);
      return relayHandler ? relayHandler(msg) : Promise.resolve({ seq: 1 });
    },
  };
  return { c, dispatched };
}

function record(overrides = {}) {
  return {
    id: 'srv',
    name: 'circle',
    channels: ['general'],
    voiceChannels: ['lounge'],
    members: ['alice', 'bob'],
    epoch: 1,
    lastSeq: 0,
    joinedAt: 1,
    ...overrides,
  };
}

test('sendChat stores the line first; a successful send clears pending', async () => {
  const { c } = makeController();
  const r = record();
  c.servers.set('srv', r);
  await c.sendChat('srv', 'general', 'hello');
  const mine = c.db.messages.filter((m) => !m.system);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, 'hello');
  assert.ok(!mine[0].pending && !mine[0].failed, 'flags cleared after the ack');
  clearTimeout(c.backupTimer);
});

test('a failed send keeps the line visible as failed; retry heals it', async () => {
  let fail = true;
  const { c } = makeController({
    relayHandler: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 2 })),
  });
  const r = record();
  c.servers.set('srv', r);

  await assert.rejects(() => c.sendChat('srv', 'general', 'lost?'));
  let mine = c.db.messages.filter((m) => !m.system);
  assert.equal(mine.length, 1, 'the message is still stored locally');
  assert.equal(mine[0].failed, true, 'and marked failed, not silently dropped');

  fail = false;
  await c.retryMessage('srv', 'general', mine[0]);
  mine = c.db.messages.filter((m) => !m.system);
  assert.ok(!mine[0].failed && !mine[0].pending, 'retry cleared the failure');
  clearTimeout(c.backupTimer);
});

test('overview edit from a stale-cached "member" is re-checked against the ACL, then applied', async () => {
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? Promise.resolve({ members: [{ user: 'alice', role: 'member' }, { user: 'bob', role: 'admin' }] })
        : Promise.resolve({ seq: 1 }),
  });
  // Local cache still thinks bob is a plain member (promotion not yet seen).
  const r = record({ roles: { bob: 'member' } });
  c.servers.set('srv', r);
  await c.onContent(r, 'bob', JSON.stringify({ k: 'overview', ov: { blurb: 'fresh hub' } }));
  assert.equal(r.overview?.blurb, 'fresh hub', 'the edit landed after the ACL re-check');
  assert.equal(r.roles.bob, 'admin', 'roles were refreshed');
  clearTimeout(c.backupTimer);
});

test('overview edit from a genuine non-admin is dropped', async () => {
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? Promise.resolve({ members: [{ user: 'alice', role: 'admin' }, { user: 'bob', role: 'member' }] })
        : Promise.resolve({ seq: 1 }),
  });
  const r = record({ roles: { bob: 'member' }, overview: { blurb: 'original', links: [] } });
  c.servers.set('srv', r);
  await c.onContent(r, 'bob', JSON.stringify({ k: 'overview', ov: { blurb: 'hijacked' } }));
  assert.equal(r.overview.blurb, 'original', 'non-admin edit stays dropped');
  clearTimeout(c.backupTimer);
});

test('the uploaded backup includes restored circles (their history keys must survive)', async () => {
  let parked = null;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_set') parked = msg.payload;
      return Promise.resolve({ seq: 1 });
    },
  });
  const identity = new Uint8Array(32).fill(7);
  c.identityBytes = () => identity;
  c.servers.set('live', record({ id: 'live', name: 'live circle' }));
  c.servers.set(
    'old',
    record({
      id: 'old',
      name: 'restored circle',
      restored: true,
      chanMeta: { general: { hid: 'h1', hkey: b64.enc(new Uint8Array(32)) } },
    })
  );
  await c.uploadBackup();
  assert.ok(parked, 'backup was parked');
  const opened = await openBackup(identity, parked);
  const ids = opened.servers.map((s) => s.id).sort();
  assert.deepEqual(ids, ['live', 'old'], 'restored circle was not dropped from the backup');
  assert.equal(opened.servers.find((s) => s.id === 'old').chanMeta.general.hid, 'h1');
});

test('presence rides the ephemeral fan-out, not the group log', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  await c.setPlaying('srv', { id: 'g1', name: 'Hex', kind: 'activity' });
  const kinds = c.relay.requests.map((r) => r.t);
  assert.deepEqual(kinds, ['ephemeral'], 'no log append for presence');
  const me = c.livePresence.get('srv').alice;
  assert.equal(me.playing.id, 'g1');
});
