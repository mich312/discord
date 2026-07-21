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
    serverDelete: async () => {},
    msgsDeleteServer: async (server) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].server === server) messages.splice(i, 1);
      }
    },
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

test('a room whose gated chan/vchan event was dropped is repaired by the meta snapshot', async () => {
  // The reported bug: a user creates channels/voice rooms that show for them
  // but never for the admin. Root cause is the role gate dropping their
  // `chan`/`vchan` events (a global admin who is only a circle member reads
  // as a non-admin here). createChannel/createVoiceChannel now trail a meta
  // snapshot, and the ungated union path adopts it — so the room appears.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? Promise.resolve({ members: [{ user: 'alice', role: 'admin' }, { user: 'bob', role: 'member' }] })
        : Promise.resolve({ seq: 1 }),
  });
  const r = record({ roles: { bob: 'member' } });
  c.servers.set('srv', r);

  // The gated events alone are dropped for a non-admin sender.
  await c.onContent(r, 'bob', JSON.stringify({ k: 'chan', ch: 'design' }));
  await c.onContent(r, 'bob', JSON.stringify({ k: 'vchan', ch: 'standup' }));
  assert.ok(!r.channels.includes('design'), 'gated chan event stays dropped');
  assert.ok(!(r.voiceChannels ?? []).includes('standup'), 'gated vchan event stays dropped');

  // The meta snapshot that trails them repairs both via the union path.
  await c.onContent(
    r,
    'bob',
    JSON.stringify({
      k: 'meta',
      name: 'circle',
      channels: ['general', 'design'],
      voiceChannels: ['lounge', 'standup'],
    })
  );
  assert.ok(r.channels.includes('design'), 'the channel is adopted from the meta union');
  assert.ok(r.voiceChannels.includes('standup'), 'the voice room is adopted too');
  clearTimeout(c.backupTimer);
});

test('a meta rebroadcast never resurrects a channel or voice room this device deleted', async () => {
  // The connect-time heal rebroadcasts meta from every device. A peer that
  // missed a deletion still lists the room; the union must respect this
  // device's tombstones instead of bringing the room back.
  const { c } = makeController();
  const r = record({
    channels: ['general'],
    voiceChannels: ['lounge'],
    deletedChannels: ['photos'],
    deletedVoice: ['standup'],
    roles: { bob: 'admin' },
  });
  c.servers.set('srv', r);
  await c.onContent(
    r,
    'bob',
    JSON.stringify({
      k: 'meta',
      name: 'circle',
      channels: ['general', 'photos'],
      voiceChannels: ['lounge', 'standup'],
    })
  );
  assert.ok(!r.channels.includes('photos'), 'deleted channel stays deleted through the union');
  assert.ok(!r.voiceChannels.includes('standup'), 'deleted voice room stays deleted too');
  clearTimeout(c.backupTimer);
});

test('renameServer sets the trimmed name and rebroadcasts it', async () => {
  const { c } = makeController();
  const r = record({ name: 'old' });
  c.servers.set('srv', r);
  await c.renameServer('srv', '  Book Club  ');
  assert.equal(r.name, 'Book Club', 'name trimmed and applied');
  const sends = c.relay.requests.filter((m) => m.t === 'send');
  assert.ok(sends.length >= 1, 'the new name went out on a group message');
  clearTimeout(c.backupTimer);
});

test('removeMember re-keys the group, revokes the ACL, and drops the role', async () => {
  const disallowed = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'disallow') disallowed.push(msg.user);
      return Promise.resolve({ seq: 2 });
    },
  });
  const base = c.crypto;
  c.crypto = async (cmd, args) =>
    cmd === 'removeMember'
      ? { commit: new Uint8Array([9]), epoch: 3, members: ['alice'], state: null }
      : base(cmd, args);
  const r = record({ members: ['alice', 'bob'], roles: { alice: 'admin', bob: 'member' } });
  c.servers.set('srv', r);
  await c.removeMember('srv', 'bob');
  assert.deepEqual(r.members, ['alice'], 'bob is gone from the MLS roster');
  assert.ok(!r.roles.bob, 'and from the local roles map');
  assert.deepEqual(disallowed, ['bob'], 'the relay ACL was revoked for bob');
  clearTimeout(c.backupTimer);
});

test('being removed by someone else forgets the circle on this device', async () => {
  const { c } = makeController();
  c.crypto = async (cmd) => {
    if (cmd === 'receive') {
      return {
        event: { kind: 'membershipChange', epoch: 4, sender: 'admin', members: ['admin', 'carol'] },
        state: null,
      };
    }
    if (cmd === 'forgetGroup') return { state: null };
    return {};
  };
  const r = record({ members: ['alice', 'admin', 'carol'] });
  c.servers.set('srv', r);
  await c.onGroupMessage({ group: 'srv', seq: 5, payload: '' });
  assert.ok(!c.servers.has('srv'), 'the circle we were kicked from is gone locally');
  clearTimeout(c.backupTimer);
});

test('leaveServer forgets the circle and revokes our own ACL', async () => {
  const disallowed = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'disallow') disallowed.push(msg.user);
      return Promise.resolve({ seq: 1 });
    },
  });
  const base = c.crypto;
  c.crypto = async (cmd, args) => (cmd === 'forgetGroup' ? { state: null } : base(cmd, args));
  c.servers.set('srv', record());
  await c.leaveServer('srv');
  assert.ok(!c.servers.has('srv'), 'the circle is forgotten locally');
  assert.deepEqual(disallowed, ['alice'], 'we removed ourselves from the relay ACL');
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

test('a rally rides the ephemeral fan-out too, never the group log', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  await c.setWant('srv', { id: 'g3', name: 'Tanks', kind: 'activity' });
  assert.deepEqual(c.relay.requests.map((r) => r.t), ['ephemeral'], 'no log append for a rally');
  assert.equal(c.liveWants.get('srv').alice.want.id, 'g3');
  // Starting a rally push-wakes the other members with a rally-labelled nudge.
  const start = c.relay.requests[0];
  assert.deepEqual(start.notify, ['bob'], 'rally push-wakes offline members');
  assert.equal(start.notify_kind, 'rally', 'push is labelled a rally, not a call');
  // Standing down clears my rally, still over the ephemeral path — and silently.
  await c.setWant('srv', null);
  assert.equal(c.liveWants.get('srv').alice.want, null, 'stand-down clears the rally');
  assert.deepEqual(c.relay.requests.map((r) => r.t), ['ephemeral', 'ephemeral']);
  const standDown = c.relay.requests[1];
  assert.equal(standDown.notify, undefined, 'standing down notifies no one');
  assert.equal(standDown.notify_kind, undefined, 'standing down carries no push label');
});
