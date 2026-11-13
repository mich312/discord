// Controller regressions: optimistic send (a message must never silently
// vanish), the stale-role gate on admin envelopes (the "game hub didn't
// sync" bug), backup contents, and ephemeral presence routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, freshTyping } from '../src/lib/controller.js';
import { FORK_THRESHOLD } from '../src/lib/fork.js';
import { b64 } from '../src/lib/relay.js';
import { openBackup, openLogEntry, sealBackup, sealLogEntry } from '../src/lib/history.js';
import { renderLog } from '../src/lib/log.js';

function fakeDb() {
  return {
    kvPut: async () => {},
    kvGet: async () => null,
  };
}

/** What the controller would render for a room: the folded channel log.
    There is no local message store any more, so this is the only answer to
    "what does this device show". */
function msgs(c, channel = 'general', server = 'srv') {
  return renderLog(c.channelLog(server, channel));
}

/** Put a message into a room the way one arriving over MLS would. */
function seed(c, { server = 'srv', channel = 'general', sender, ts, text, ...rest }) {
  c.applyLiveEntry(server, channel, { k: 'chat', sender, ts, text, ...rest });
}

function fakeCrypto() {
  return async (cmd, args = {}) => {
    if (cmd === 'send') return { blob: new Uint8Array([1, 2, 3]), epoch: 1, state: null };
    if (cmd === 'receive') throw new Error('not used in these tests');
    // Signing and verification live in the worker; here they are stubs that
    // always agree, so tests exercise the fold rather than Ed25519. The
    // tests that care about a bad signature override this.
    if (cmd === 'sign') return new Uint8Array(64);
    if (cmd === 'verifyEntries') return (args.items ?? []).map(() => true);
    if (cmd === 'memberKeys') return {};
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
  const mine = msgs(c).filter((m) => !m.system);
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
  let mine = msgs(c).filter((m) => !m.system);
  assert.equal(mine.length, 1, 'the message is still stored locally');
  assert.equal(mine[0].failed, true, 'and marked failed, not silently dropped');

  fail = false;
  await c.retryMessage('srv', 'general', mine[0]);
  mine = msgs(c).filter((m) => !m.system);
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
  // removeMember only STAGES the commit now; the roster moves on merge,
  // which happens after the relay has accepted it into the log.
  c.crypto = async (cmd, args) => {
    if (cmd === 'removeMember') return { commit: new Uint8Array([9]), epoch: 3, state: null };
    if (cmd === 'mergeStagedCommit') return { epoch: 3, members: ['alice'], state: null };
    return base(cmd, args);
  };
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

test('the uploaded backup includes restored circles (their room keys must survive)', async () => {
  let parked = null;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_set') parked = msg.payload;
      return Promise.resolve({ seq: 1, version: 4 });
    },
  });
  const identity = new Uint8Array(32).fill(7);
  c.identityBytes = () => identity;
  // The blob is the circles, so a device that has not managed to read it
  // is not allowed to write one. Every upload test has to say it has read.
  c.circlesLoaded = true;
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
  assert.equal(c.backupVersion, 4, 'the version the next write must swap against is kept');
});

test('a device that has never read the circles refuses to write over them', async () => {
  // The failure this closes: relay up enough to authenticate, `backup_get`
  // failing, this device holding no circles — and one debounce later
  // parking that emptiness as the truth for every other device.
  let parked = null;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_set') parked = msg.payload;
      return Promise.resolve({ seq: 1 });
    },
  });
  c.identityBytes = () => new Uint8Array(32).fill(7);
  await c.uploadBackup();
  assert.equal(parked, null, 'nothing was written');
});

test('losing the compare-and-swap merges the other device\'s circles instead of clobbering them', async () => {
  // Two signed-in devices. Ours edits "mine" while theirs joins "theirs".
  // A blind overwrite drops one of the two — which, now that the blob is
  // the only copy, means a circle simply disappears from the account.
  const identity = new Uint8Array(32).fill(9);
  const theirs = await sealBackup(identity, {
    v: 2,
    servers: [
      { id: 'theirs', name: 'joined elsewhere', channels: ['general'], chanMeta: {} },
      { id: 'mine', name: 'stale name', channels: ['general'], chanMeta: {} },
    ],
  });
  const writes = [];
  let first = true;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_get') return Promise.resolve({ payload: theirs, version: 8 });
      if (msg.t === 'backup_set') {
        writes.push(msg);
        if (first) {
          first = false;
          return Promise.reject(new Error('backup conflict: another device wrote a newer backup'));
        }
        return Promise.resolve({ version: 9 });
      }
      return Promise.resolve({ seq: 1 });
    },
  });
  c.identityBytes = () => identity;
  c.circlesLoaded = true;
  c.backupVersion = 7;
  c.servers.set('mine', record({ id: 'mine', name: 'my newer name' }));

  await c.uploadBackup();

  assert.equal(writes.length, 2, 'the rejected write was retried, once');
  assert.equal(writes[0].version, 7, 'the first write swapped against what we had read');
  assert.equal(writes[1].version, 8, 'the retry swapped against what we re-read');
  const opened = await openBackup(identity, writes[1].payload);
  const byId = Object.fromEntries(opened.servers.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['mine', 'theirs'], 'neither circle was lost');
  assert.equal(byId.mine.name, 'my newer name', 'our edit — the reason for this write — wins');
  assert.ok(c.servers.has('theirs'), 'and the circle the merge rescued is now on screen');
});

test('circles are loaded from the relay on connect, not from this device', async () => {
  const identity = new Uint8Array(32).fill(3);
  const payload = await sealBackup(identity, {
    v: 2,
    servers: [
      {
        id: 'srv',
        name: 'from the relay',
        channels: ['general'],
        chanMeta: { general: { hid: 'h1', hkey: b64.enc(new Uint8Array(32)) } },
      },
    ],
  });
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_get'
        ? Promise.resolve({ payload, version: 2 })
        : Promise.resolve({ seq: 1, entries: [], complete: true }),
  });
  c.identityBytes = () => identity;
  c.deviceState = {};

  const fresh = await c.loadCircles();

  assert.equal(fresh.length, 1);
  const r = c.servers.get('srv');
  assert.equal(r.name, 'from the relay');
  assert.equal(r.chanMeta.general.hid, 'h1', 'the room key came with it');
  assert.equal(r.restored, true, 'no MLS state on this device: readable, not sendable');
  assert.equal(c.backupVersion, 2);
});

// --- the "we do not know yet" state -------------------------------------
// Circles arrive over the network now, so there is a window where the app is
// up and the answer is not in yet. An empty rail during that window is not a
// blank screen, it is a *claim* — that you are in no circles — and it is
// usually wrong. These pin the flag that lets the UI say "asking" instead.

test('loading is announced as finished once the circles are in', async () => {
  const identity = new Uint8Array(32).fill(3);
  const payload = await sealBackup(identity, {
    v: 2,
    servers: [{ id: 'srv', name: 'a circle', channels: ['general'], chanMeta: {} }],
  });
  const { c, dispatched } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_get'
        ? Promise.resolve({ payload, version: 1 })
        : Promise.resolve({ seq: 1, entries: [], complete: true }),
  });
  c.identityBytes = () => identity;

  await c.loadCircles();

  const flags = dispatched.filter((a) => a.type === 'circlesLoading');
  assert.deepEqual(flags.at(-1), { type: 'circlesLoading', loading: false });
});

test('a relay that cannot serve the circles still ends the loading state', async () => {
  // The failure this closes is a placeholder that spins forever. The toast
  // carries the reason; the rail must go back to saying something finite,
  // because "still loading" an hour later is a lie of its own.
  const { c, dispatched } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_get'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ seq: 1 }),
  });
  c.identityBytes = () => new Uint8Array(32).fill(3);

  await assert.rejects(() => c.loadCircles(), /offline/);

  const flags = dispatched.filter((a) => a.type === 'circlesLoading');
  assert.deepEqual(flags.at(-1), { type: 'circlesLoading', loading: false });
  assert.equal(c.circlesLoaded, undefined, 'and the write guard stays shut');
});

// --- leaving is an account-level act, not a device-level one -------------
// The confirm dialog says so, so it had better be true.

test('leaving a circle drops it from the parked blob, not just from memory', async () => {
  const identity = new Uint8Array(32).fill(5);
  let parked = null;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_set') parked = msg.payload;
      return Promise.resolve({ seq: 1, version: 2 });
    },
  });
  c.identityBytes = () => identity;
  c.circlesLoaded = true;
  c.servers.set('stay', record({ id: 'stay', name: 'keeping this' }));
  c.servers.set('go', record({ id: 'go', name: 'leaving this' }));
  c.deviceState = { stay: { live: true }, go: { live: true } };

  await c.leaveServer('go');
  clearTimeout(c.backupTimer);
  await c.uploadBackup();

  const opened = await openBackup(identity, parked);
  assert.deepEqual(opened.servers.map((s) => s.id), ['stay'], 'the circle left the account');
  assert.ok(!c.deviceState.go, 'and this device kept no state for it');
  assert.ok(c.deviceState.stay, 'while the one we stayed in is untouched');
});

test('a circle this device holds MLS state for loads live, with its own cursor', async () => {
  const identity = new Uint8Array(32).fill(3);
  const payload = await sealBackup(identity, {
    v: 2,
    servers: [{ id: 'srv', name: 'live one', channels: ['general'], chanMeta: {} }],
  });
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_get'
        ? Promise.resolve({ payload, version: 1 })
        : Promise.resolve({ seq: 1, entries: [], complete: true }),
  });
  c.identityBytes = () => identity;
  // What the device kept: its place in the stream and what it had read.
  // Neither is in the blob, and neither should be — another device of the
  // same account is somewhere else entirely.
  c.deviceState = { srv: { lastSeq: 42, seen: { general: 1234 } } };
  // And what makes it live is the ratchet, reported by `boot`.
  c.mlsGroups = new Set(['srv']);

  await c.loadCircles();

  const r = c.servers.get('srv');
  assert.ok(!r.restored, 'this device can send');
  assert.equal(r.lastSeq, 42, 'and resumes where it left off');
  assert.equal(r.seen.general, 1234, 'with its own read markers');
});

test('an upgraded device with ratchets but no device state is not marked read-only', () => {
  // The shipped regression, at the level it actually bit: `deviceState` is a
  // new store, so it is empty on every install that predates it. Reading
  // liveness out of it marked every existing circle read-only — and a
  // read-only record is skipped by the subscribe loop, so the circle also
  // stopped receiving. Both symptoms, one wrong source of truth.
  const { c } = makeController();
  c.mlsGroups = new Set(['srv']);
  c.deviceState = {};

  const [r] = c.adoptCircles([{ id: 'srv', name: 'a circle', channels: ['general'] }]);

  assert.ok(!r.restored, 'the ratchet says this device can send, so it can');
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

test('a reply carries a quoted snapshot into the log and the live send', async () => {
  const appended = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'history_append') appended.push(msg);
      return Promise.resolve({ seq: 1 });
    },
  });
  const hkey = b64.enc(new Uint8Array(32));
  const r = record({ chanMeta: { general: { hid: 'h1', hkey } } });
  c.servers.set('srv', r);
  await c.sendChat('srv', 'general', 'agreed', { sender: 'bob', ts: 111, text: 'ship it?' });
  const mine = msgs(c).filter((m) => !m.system);
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].reply, { sender: 'bob', ts: 111, text: 'ship it?' }, 'quote on the line');
  const sent = c.relay.requests.find((m) => m.t === 'send');
  assert.ok(sent, 'the chat went out live as well');
  assert.equal(appended.length, 1, 'and the reply was written to the channel log');
  const entry = await openLogEntry(hkey, appended[0].payload);
  assert.deepEqual(entry.reply, { sender: 'bob', ts: 111, text: 'ship it?' }, 'quote sealed in');
  assert.equal(entry.k, 'chat', 'entries are typed now');
  assert.ok(entry.sig, 'and signed by their author');
  clearTimeout(c.backupTimer);
});

test('a malformed reply is dropped, not stored', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  // No ts — not a resolvable quote.
  await c.sendChat('srv', 'general', 'hi', { sender: 'bob', text: 'no ts' });
  const mine = msgs(c).filter((m) => !m.system);
  assert.equal(mine[0].reply, undefined, 'garbage quote left off the line');
  clearTimeout(c.backupTimer);
});

test('a received chat carries its reply through and clears the sender typing', async () => {
  const { c } = makeController();
  const r = record();
  c.servers.set('srv', r);
  // Bob is mid-compose…
  c.setLiveTyping('srv', 'bob', 'general');
  assert.ok(c.liveTyping.get('srv').bob, 'typing signal is live');
  // …then his line (a reply) lands.
  await c.onContent(
    r,
    'bob',
    JSON.stringify({ k: 'chat', ch: 'general', text: 'yes', ts: 222, reply: { sender: 'alice', ts: 200, text: 'ok?' } })
  );
  const stored = msgs(c).find((m) => !m.system && m.sender === 'bob');
  assert.deepEqual(stored.reply, { sender: 'alice', ts: 200, text: 'ok?' }, 'incoming quote preserved');
  assert.ok(!c.liveTyping.get('srv').bob, 'the landed line cleared bob’s typing signal');
  clearTimeout(c.backupTimer);
});

test('typing rides the ephemeral fan-out, is throttled, and never push-wakes', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  await c.typing('srv', 'general');
  await c.typing('srv', 'general'); // within the heartbeat window — coalesced
  const eph = c.relay.requests.filter((m) => m.t === 'ephemeral');
  assert.equal(eph.length, 1, 'a burst of keystrokes sends one signal, not many');
  assert.equal(eph[0].notify, undefined, 'typing never wakes a closed app');
  // My own typing is never reflected back at me.
  assert.equal(c.liveTyping?.get('srv')?.alice, undefined);
});

test('freshTyping expires a signal after its window', () => {
  const t0 = 10_000;
  assert.equal(freshTyping({ ts: t0 }, t0 + 1000), true, 'fresh within the window');
  assert.equal(freshTyping({ ts: t0 }, t0 + 9000), false, 'stale past it');
  assert.equal(freshTyping(null, t0), false, 'no entry is never fresh');
});

test('editMessage patches my own line, marks it edited, and fans out an edit', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  await c.sendChat('srv', 'general', 'helo');
  await c.editMessage('srv', 'general', msgs(c).find((m) => !m.system), 'hello');
  const line = msgs(c).find((m) => !m.system);
  assert.equal(line.text, 'hello', 'text updated in place');
  assert.equal(line.edited, true, 'edited marker set');
  const edit = c.relay.requests.filter((m) => m.t === 'send');
  assert.ok(edit.length >= 2, 'the edit went out on the group log');
  clearTimeout(c.backupTimer);
});

test('an incoming edit can only touch its own author’s line', async () => {
  const { c } = makeController();
  const r = record();
  c.servers.set('srv', r);
  // A line authored by bob.
  seed(c, { sender: 'bob', text: 'original', ts: 500 });
  // Mallory tries to rewrite bob's line (same ts) — the (sender, ts) key misses.
  await c.onContent(r, 'mallory', JSON.stringify({ k: 'edit', ch: 'general', to: { ts: 500 }, text: 'hijacked' }));
  assert.equal(msgs(c).find((m) => m.ts === 500).text, 'original', 'a stranger cannot edit it');
  // Bob edits his own line — it lands.
  await c.onContent(r, 'bob', JSON.stringify({ k: 'edit', ch: 'general', to: { ts: 500 }, text: 'fixed' }));
  assert.equal(msgs(c).find((m) => m.ts === 500).text, 'fixed', 'the author’s edit lands');
  assert.equal(msgs(c).find((m) => m.ts === 500).edited, true);
  clearTimeout(c.backupTimer);
});

test('deleteMessage tombstones my line and strips its body; a delete fans out', async () => {
  const { c } = makeController();
  c.servers.set('srv', record());
  await c.sendChat('srv', 'general', 'oops wrong channel', { sender: 'bob', ts: 9, text: 'x' });
  await c.deleteMessage('srv', 'general', msgs(c).find((m) => !m.system));
  const line = msgs(c).find((m) => !m.system);
  assert.equal(line.deleted, true, 'tombstoned');
  assert.equal(line.text, undefined, 'body stripped');
  assert.equal(line.reply, undefined, 'quote stripped too');
  clearTimeout(c.backupTimer);
});

/** Seal `entries` the way a member's client would, into one channel log. */
async function sealedLog(hkey, group, hid, entries) {
  const sign = async () => new Uint8Array(64);
  const out = [];
  for (const [i, entry] of entries.entries()) {
    out.push({ seq: i + 1, payload: await sealLogEntry(hkey, group, hid, entry, sign) });
  }
  return out;
}

test('opening a channel reads it back from the relay, edits and deletions folded', async () => {
  // The whole conversation, as it sits in the relay's log: a line, an edit
  // of it, and a deletion of another — the state a device that was never
  // online for any of it has to arrive at.
  const hkey = b64.enc(new Uint8Array(32));
  const entries = await sealedLog(hkey, 'srv', 'h1', [
    { v: 1, k: 'chat', sender: 'alice', ts: 100, text: 'to be deleted' },
    { v: 1, k: 'chat', sender: 'alice', ts: 200, text: 'original wording' },
    { v: 1, k: 'edit', sender: 'alice', ts: 300, to: { ts: 200 }, text: 'edited wording' },
    { v: 1, k: 'del', sender: 'alice', ts: 400, to: { ts: 100 } },
  ]);
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_fetch'
        ? Promise.resolve({ entries, complete: true })
        : Promise.resolve({ seq: 1 }),
  });
  // A mutation only applies when its author's signature checked out, so the
  // circle must hold a key for alice.
  const r = record({
    chanMeta: { general: { hid: 'h1', hkey } },
    keys: { alice: b64.enc(new Uint8Array(32)) },
  });
  c.servers.set('srv', r);

  const shown = await c.loadMessages('srv', 'general');
  const at100 = shown.filter((m) => m.ts === 100);
  const at200 = shown.filter((m) => m.ts === 200);
  assert.equal(at100.length, 1, 'the deleted line keeps its place');
  assert.equal(at100[0].deleted, true, 'as a tombstone');
  assert.equal(at100[0].text, undefined, 'with its body gone');
  assert.equal(at200.length, 1, 'the edited line is not duplicated by its original');
  assert.equal(at200[0].text, 'edited wording', 'the edit is folded over it');
  assert.equal(at200[0].edited, true);
  clearTimeout(c.backupTimer);
});

test('a live line and its log entry are one message, not two', async () => {
  // The sender writes both; a reader gets the MLS copy now and the log copy
  // on its next read. Keyed on (sender, ts), they must collapse.
  const hkey = b64.enc(new Uint8Array(32));
  const entries = await sealedLog(hkey, 'srv', 'h1', [
    { v: 1, k: 'chat', sender: 'bob', ts: 700, text: 'hello' },
  ]);
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_fetch'
        ? Promise.resolve({ entries, complete: true })
        : Promise.resolve({ seq: 1 }),
  });
  const r = record({ chanMeta: { general: { hid: 'h1', hkey } } });
  c.servers.set('srv', r);

  await c.onContent(r, 'bob', JSON.stringify({ k: 'chat', ch: 'general', text: 'hello', ts: 700 }));
  const shown = await c.loadMessages('srv', 'general');
  assert.equal(shown.filter((m) => !m.system).length, 1, 'one line, not one per path');
  assert.equal(shown[0].seq, 1, 'and it is the relay copy that stands, with its seq');
  clearTimeout(c.backupTimer);
});

test('an entry whose signature does not verify is dropped, not shown unsigned', async () => {
  // The room key is held by the whole roster, so it proves membership, not
  // authorship. An entry that fails its signature is somebody with the key
  // writing in another member's name.
  const hkey = b64.enc(new Uint8Array(32));
  const entries = await sealedLog(hkey, 'srv', 'h1', [
    { v: 1, k: 'chat', sender: 'alice', ts: 100, text: 'genuine' },
    { v: 1, k: 'chat', sender: 'alice', ts: 200, text: 'forged in her name' },
  ]);
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_fetch'
        ? Promise.resolve({ entries, complete: true })
        : Promise.resolve({ seq: 1 }),
  });
  // The second entry fails verification.
  const base = c.crypto;
  c.crypto = async (cmd, args = {}) =>
    cmd === 'verifyEntries' ? (args.items ?? []).map((_, i) => i === 0) : base(cmd, args);
  const r = record({ chanMeta: { general: { hid: 'h1', hkey } }, keys: { alice: b64.enc(new Uint8Array(32)) } });
  c.servers.set('srv', r);

  const shown = await c.loadMessages('srv', 'general');
  assert.deepEqual(shown.map((m) => m.text), ['genuine'], 'the forgery never reaches the room');
  clearTimeout(c.backupTimer);
});

test('an unsigned mutation cannot rewrite a line, though unsigned content still reads', async () => {
  // Entries written before signatures existed stay readable — dropping them
  // would delete real conversations. Mutations are different: there is no
  // legacy of them, and they are what a room-key holder would forge to
  // tamper with someone else's message.
  const hkey = b64.enc(new Uint8Array(32));
  const entries = [
    // No signature at all, the pre-signature wire shape.
    { seq: 1, payload: await sealLogEntry(hkey, 'srv', 'h1', { sender: 'alice', ts: 100, text: 'old line' }, async () => new Uint8Array(64)) },
    { seq: 2, payload: await sealLogEntry(hkey, 'srv', 'h1', { v: 1, k: 'edit', sender: 'alice', ts: 200, to: { ts: 100 }, text: 'rewritten' }, async () => new Uint8Array(64)) },
  ];
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_fetch'
        ? Promise.resolve({ entries, complete: true })
        : Promise.resolve({ seq: 1 }),
  });
  // No key for alice: every entry is 'unknown' rather than 'signed'.
  c.crypto = async (cmd, args = {}) => (cmd === 'verifyEntries' ? (args.items ?? []).map(() => true) : {});
  const r = record({ chanMeta: { general: { hid: 'h1', hkey } } });
  c.servers.set('srv', r);

  const shown = await c.loadMessages('srv', 'general');
  assert.equal(shown.length, 1, 'the unattributable line still reads');
  assert.equal(shown[0].text, 'old line', 'and the unattributable edit did not touch it');
  assert.equal(shown[0].auth, 'unknown', 'flagged for the UI rather than trusted');
  clearTimeout(c.backupTimer);
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

// --- §0.6: the admin gate fails closed for destructive envelopes ----------
// Previously senderIsAdmin returned true whenever the role was unknown, so a
// non-admin's chan-del reached db.msgsDelete during the window before a fresh
// joiner's first roster fetch landed — irreversible local history loss.

test('chan-del from a sender whose role cannot be established is dropped, not applied', async () => {
  const { c } = makeController({
    // The ACL fetch fails, so the role stays unknown even after the re-pull.
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  const r = record({ channels: ['general', 'design'] });
  c.servers.set('srv', r);
  seed(c, { channel: 'design', sender: 'bob', ts: 1, text: 'keep me' });

  await c.onContent(r, 'mallory', JSON.stringify({ k: 'chan-del', ch: 'design' }));

  assert.ok(r.channels.includes('design'), 'the channel survives an unestablished sender');
  assert.equal(
    msgs(c, 'design').filter((m) => !m.system).length,
    1,
    'and its history was not deleted'
  );
  clearTimeout(c.backupTimer);
});

test('chanset from a sender whose role cannot be established cannot flip kept history', async () => {
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  const r = record();
  c.servers.set('srv', r);

  await c.onContent(
    r,
    'mallory',
    JSON.stringify({ k: 'chanset', ch: 'general', meta: { hid: 'log1', hkey: 'k', retention: 3600, topic: 'x' } })
  );

  // Retention is what makes the relay delete entries, and the topic is the
  // room's. Neither is taken from a sender who is not known to be an admin.
  assert.equal(r.chanMeta?.general?.retention, undefined, 'the settings change was refused');
  assert.equal(r.chanMeta?.general?.topic, undefined);
  // The room key is another matter: any member may announce one, or a room
  // first written to by a non-admin could be read by nobody else.
  assert.equal(r.chanMeta?.general?.hkey, 'k');
  clearTimeout(c.backupTimer);
});

test('a real admin still gets destructive envelopes applied after the ACL re-pull', async () => {
  // The fail-closed path must not break the promotion-lag case: bob is cached
  // as a member but the ACL says admin, so his delete must still land.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? Promise.resolve({ members: [{ user: 'alice', role: 'member' }, { user: 'bob', role: 'admin' }] })
        : Promise.resolve({ seq: 1 }),
  });
  const r = record({ channels: ['general', 'design'], roles: { bob: 'member' } });
  c.servers.set('srv', r);

  await c.onContent(r, 'bob', JSON.stringify({ k: 'chan-del', ch: 'design' }));

  assert.ok(!r.channels.includes('design'), 'the promoted admin’s delete landed');
  assert.equal(r.roles.bob, 'admin', 'roles were refreshed');
  clearTimeout(c.backupTimer);
});

test('additive envelopes still fail open when the role is unknown', async () => {
  // Deliberate asymmetry: a stray channel is recoverable, deleted history is
  // not, so `chan` keeps the permissive behaviour `chan-del` gives up.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  const r = record();
  c.servers.set('srv', r);

  await c.onContent(r, 'newcomer', JSON.stringify({ k: 'chan', ch: 'design' }));

  assert.ok(r.channels.includes('design'), 'an additive create from an unknown role still applies');
  clearTimeout(c.backupTimer);
});

// --- §0.2: verification is bound to a key, not a handle -------------------
// Previously markVerified stored only the peer's handle, so the ✓ survived a
// key change — including a relay substituting a KeyPackage for that handle,
// which is exactly what safety numbers exist to detect.

function verifyController(safetyNumbers) {
  // safetyNumbers: peer -> current number, mutable between calls so a test
  // can simulate the peer's key changing under it.
  const { c, dispatched } = makeController();
  c.crypto = async (cmd, args) => {
    if (cmd === 'safetyNumber') {
      const sn = safetyNumbers[args.peer];
      if (!sn) throw new Error(`no member named ${args.peer}`);
      return sn;
    }
    return {};
  };
  return { c, dispatched };
}

test('markVerified records the safety number that was actually compared', async () => {
  const { c } = verifyController({ bob: '11111 22222' });
  const r = record();
  c.servers.set('srv', r);

  await c.markVerified('srv', 'bob');

  assert.equal(r.verifiedSn.bob, '11111 22222', 'the checked number is stored');
  assert.deepEqual(r.verified, ['bob'], 'and the roster array still renders it');
  clearTimeout(c.backupTimer);
});

test("a peer's key changing clears their badge on the next membership change", async () => {
  const numbers = { bob: '11111 22222' };
  const { c } = verifyController(numbers);
  const r = record();
  c.servers.set('srv', r);
  await c.markVerified('srv', 'bob');

  // The relay substitutes a different key for the same handle: the safety
  // number moves, which is the only signal that anything happened.
  numbers.bob = '99999 88888';
  const changed = await c.revalidateVerified(r);

  assert.equal(changed, true, 'the change was detected');
  assert.deepEqual(r.verified, [], 'the ✓ is gone');
  assert.equal(r.verifiedSn.bob, undefined, 'and the stale binding was dropped');
  assert.ok(
    msgs(c).some((m) => m.system && m.text.includes("bob's safety number changed")),
    'the user is told, rather than the badge silently vanishing'
  );
  clearTimeout(c.backupTimer);
});

test('an unchanged key keeps the badge across membership changes', async () => {
  const { c } = verifyController({ bob: '11111 22222' });
  const r = record();
  c.servers.set('srv', r);
  await c.markVerified('srv', 'bob');

  const changed = await c.revalidateVerified(r);

  assert.equal(changed, false, 'nothing moved');
  assert.deepEqual(r.verified, ['bob'], 'the ✓ survives a routine epoch bump');
  clearTimeout(c.backupTimer);
});

test('legacy handle-only verifications are reset rather than trusted', async () => {
  // A record written before this change proves the user compared digits once,
  // but not against which key — so it cannot rule out a later substitution.
  const { c } = verifyController({ bob: '11111 22222' });
  const r = record({ verified: ['bob'] });
  c.servers.set('srv', r);

  const changed = await c.revalidateVerified(r);

  assert.equal(changed, true);
  assert.deepEqual(r.verified, [], 'the unbound badge is dropped');
  assert.ok(
    msgs(c).some((m) => m.system && m.text.includes('Verification badges were reset')),
    'and the reset is explained'
  );
  clearTimeout(c.backupTimer);
});

test('a verified member who left keeps their binding, so a re-add is still checked', async () => {
  const numbers = { bob: '11111 22222' };
  const { c } = verifyController(numbers);
  const r = record();
  c.servers.set('srv', r);
  await c.markVerified('srv', 'bob');

  // bob is removed: no MLS view of him, so nothing to compare yet.
  r.members = ['alice'];
  delete numbers.bob;
  await c.revalidateVerified(r);
  assert.equal(r.verifiedSn.bob, '11111 22222', 'the binding is retained while he is away');

  // He is re-added with a fresh key — that must not silently re-verify him.
  r.members = ['alice', 'bob'];
  numbers.bob = '55555 44444';
  await c.revalidateVerified(r);
  assert.deepEqual(r.verified, [], 'the re-add is caught by the retained binding');
  clearTimeout(c.backupTimer);
});

// --- removal has to close every door, not just the MLS one ---------------
// The MLS commit re-keys the group, but two other doors stayed open: the
// per-channel kept-history key was minted once and never rotated, and
// removal *refreshed* parked invite blobs, keeping alive any link the
// removed member still held.

test('removing someone rotates every kept-history key and keeps the old ones for reading', async () => {
  const { c } = makeController();
  const base = c.crypto;
  c.crypto = async (cmd, args) => {
    if (cmd === 'removeMember') return { commit: new Uint8Array([9]), epoch: 3, state: null };
    if (cmd === 'mergeStagedCommit') return { epoch: 3, members: ['alice'], state: null };
    return base(cmd, args);
  };
  const r = record({
    members: ['alice', 'bob'],
    roles: { alice: 'admin', bob: 'member' },
    chanMeta: {
      general: { hid: 'log1', hkey: 'OLD-KEY' },
      chatter: {}, // history off — nothing to rotate
    },
  });
  c.servers.set('srv', r);

  await c.removeMember('srv', 'bob');

  const meta = r.chanMeta.general;
  assert.notEqual(meta.hkey, 'OLD-KEY', 'the write key moved, so bob cannot read what comes next');
  assert.deepEqual(meta.hkeys, ['OLD-KEY'], 'the superseded key is kept so members can still read the past');
  assert.equal(r.chanMeta.chatter.hkey, undefined, 'a channel without history is untouched');
  assert.ok(
    msgs(c).some((m) => m.system && m.text.includes('new history key for #general')),
    'and the rotation is announced'
  );
  clearTimeout(c.backupTimer);
});

test('removing someone revokes the circle’s invite links instead of refreshing them', async () => {
  const revoked = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'revoke_invite') revoked.push(msg.invite);
      if (msg.t === 'update_invite') throw new Error('a removed member’s link must not be refreshed');
      return Promise.resolve({ seq: 2 });
    },
  });
  const base = c.crypto;
  c.crypto = async (cmd, args) => {
    if (cmd === 'removeMember') return { commit: new Uint8Array([9]), epoch: 3, state: null };
    if (cmd === 'mergeStagedCommit') return { epoch: 3, members: ['alice'], state: null };
    return base(cmd, args);
  };
  const r = record({
    members: ['alice', 'bob'],
    roles: { alice: 'admin', bob: 'member' },
    invites: [{ id: 'inv1', key: 'k1' }, { id: 'inv2', key: 'k2' }],
  });
  c.servers.set('srv', r);

  await c.removeMember('srv', 'bob');

  assert.deepEqual(revoked, ['inv1', 'inv2'], 'every parked link is killed');
  assert.deepEqual(r.invites, [], 'and dropped locally');
  assert.ok(
    msgs(c).some((m) => m.system && m.text.includes('2 invite links revoked')),
    'the admin is told, since this also invalidates links for pending joiners'
  );
  clearTimeout(c.backupTimer);
});

// --- §1.2: the receive path persists in a crash-safe order ---------------
// Ratchet → message → cursor meant a crash mid-sequence advanced the ratchet
// past a message whose seq was never recorded; the replay then failed to
// decrypt and was dropped silently. Cursor before ratchet inverts which side
// a crash lands on, and a stale ratchet is recoverable where a lost message
// is not.

test('the receive cursor is durable before the ratchet snapshot is', async () => {
  const writes = [];
  const { c } = makeController();
  const baseDb = c.db;
  c.db = {
    ...baseDb,
    kvPut: async (k, v) => {
      writes.push(`kv:${k}`);
      return baseDb.kvPut(k, v);
    },
  };
  c.crypto = async (cmd, args = {}) => {
    if (cmd === 'receive') {
      return {
        event: { kind: 'message', sender: 'bob', text: 'hello', epoch: 1 },
        state: new Uint8Array([1, 2, 3]),
      };
    }
    if (cmd === 'verifyEntries') return (args.items ?? []).map(() => true);
    return {};
  };
  c.servers.set('srv', record());

  await c.onGroupMessage({ group: 'srv', seq: 7, epoch: 1, sender: 'bob', payload: 'AAAA' });

  const ratchetAt = writes.indexOf('kv:mlsState');
  // The cursor moved stores — it is device state now, not part of a circle
  // record — but the ordering question it answers is unchanged.
  const cursorAt = writes.indexOf('kv:deviceState');
  assert.ok(ratchetAt !== -1, 'the ratchet was persisted');
  assert.ok(cursorAt !== -1 && cursorAt < ratchetAt, 'the cursor lands before the ratchet');
  // The message itself is no longer part of this ordering question: it is
  // durable because the sender wrote it to the relay's log, not because
  // this device managed to write it down before crashing.
  assert.equal(msgs(c).filter((m) => !m.system).length, 1, 'and the line is on screen');
  clearTimeout(c.backupTimer);
});

test('a line whose log append fails is shown as failed, and retry re-sends it', async () => {
  // The storage question moved: there is no local write to fail. What can
  // fail is the append to the relay, and that is the one that decides
  // whether the message is in the conversation at all — so it must not look
  // delivered.
  let fail = true;
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_append' && fail
        ? Promise.reject(new Error('the disk is full'))
        : Promise.resolve({ seq: 1 }),
  });
  c.servers.set('srv', record());

  await assert.rejects(() => c.sendChat('srv', 'general', 'did this land?'));
  let mine = msgs(c).filter((m) => !m.system);
  assert.equal(mine.length, 1, 'the line is still on screen');
  assert.equal(mine[0].failed, true, 'and marked failed rather than looking sent');

  fail = false;
  await c.retryMessage('srv', 'general', mine[0]);
  mine = msgs(c).filter((m) => !m.system);
  assert.equal(mine.length, 1, 'the retry did not double it');
  assert.ok(!mine[0].failed, 'and cleared the failure');
  clearTimeout(c.backupTimer);
});

// --- iOS storage eviction ------------------------------------------------
// persist() ran once during onboarding with its result discarded. Safari
// does not implement it, so the optional chain silently no-opped, and
// WebKit clears script-writable storage for a non-installed site after 7
// days idle — taking the IndexedDB MLS state and the localStorage identity
// mirror with it. Silent, total account loss.

test('a browser that refuses persistent storage is reported, not ignored', async () => {
  const { c, dispatched } = makeController();
  // navigator is a getter-only global in Node, so stub via defineProperty.
  const restore = stubNavigator({
    storage: {},
    userAgent: 'Mozilla/5.0 (iPhone) Version/17.0 Safari/605',
  });

  const ok = await c.requestPersistentStorage();

  assert.equal(ok, false, 'a browser without the API is not durable');
  const warned = dispatched.find((a) => a.type === 'storageAtRisk');
  assert.ok(warned, 'the app is told storage is at risk');
  assert.equal(warned.evicts, true, 'and that this browser actually evicts');
  restore();
  clearTimeout(c.backupTimer);
});

test('an already-persisted origin is not re-prompted', async () => {
  const { c, dispatched } = makeController();
  let persistCalls = 0;
  const restore = stubNavigator({
    storage: {
      persisted: async () => true,
      persist: async () => {
        persistCalls += 1;
        return true;
      },
    },
    userAgent: 'Chrome',
  });

  const ok = await c.requestPersistentStorage();

  assert.equal(ok, true);
  assert.equal(persistCalls, 0, 'an existing grant is not asked for again');
  assert.ok(!dispatched.some((a) => a.type === 'storageAtRisk'), 'and nothing is warned about');
  restore();
  clearTimeout(c.backupTimer);
});

/** Replace the getter-only `navigator` global for one test. */
function stubNavigator(value) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  };
}

/* ============================================================ §2.3 gaps == */

// senderIsAdmin's fail-OPEN path. Only the closed path was tested. The two
// directions are deliberately different: an advisory envelope must survive
// roles that have not synced yet, while a destructive one must not — and a
// regression in either direction is invisible until someone loses a channel.

test('an advisory envelope from an unknown sender is applied — fail open', async () => {
  // A legitimate action racing role sync must not be dropped. The relay's
  // ACL is advisory anyway; MLS is what actually gates membership.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.resolve({ members: [] }) : Promise.resolve({ seq: 1 }),
  });
  const r = record({ roles: {} });
  c.servers.set('srv', r);

  assert.equal(await c.senderIsAdmin(r, 'stranger'), true, 'advisory: unknown role passes');
  await c.onContent(r, 'stranger', JSON.stringify({ k: 'chan', ch: 'design' }));
  assert.ok(r.channels.includes('design'), 'the channel was created');
  clearTimeout(c.backupTimer);
});

test('a destructive envelope from an unknown sender is dropped — fail closed', async () => {
  // This one reaches db.msgsDelete. Applying it from a sender whose role we
  // cannot establish is a security downgrade, so it fails the other way.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.resolve({ members: [] }) : Promise.resolve({ seq: 1 }),
  });
  const r = record({ channels: ['general', 'design'], roles: {} });
  c.servers.set('srv', r);

  assert.equal(await c.senderIsAdmin(r, 'stranger', { destructive: true }), false);
  await c.onContent(r, 'stranger', JSON.stringify({ k: 'chan-del', ch: 'design' }));
  assert.deepEqual(r.channels, ['general', 'design'], 'the channel survives');
  clearTimeout(c.backupTimer);
});

test('an established non-admin is refused in BOTH directions', async () => {
  // Once the role is known, "member" is authoritative — fail-open only ever
  // applies to not-yet-known, never to known-and-not-admin.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? Promise.resolve({ members: [{ user: 'mallory', role: 'member' }] })
        : Promise.resolve({ seq: 1 }),
  });
  const r = record({ roles: {} });
  c.servers.set('srv', r);

  assert.equal(await c.senderIsAdmin(r, 'mallory'), false, 'advisory');
  assert.equal(await c.senderIsAdmin(r, 'mallory', { destructive: true }), false, 'destructive');
  clearTimeout(c.backupTimer);
});

test('a cached admin is trusted without a round trip', async () => {
  // Otherwise every admin envelope costs an ACL fetch.
  let acl = 0;
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'members') acl += 1;
      return Promise.resolve({ members: [] });
    },
  });
  const r = record({ roles: { bob: 'admin' } });
  c.servers.set('srv', r);
  assert.equal(await c.senderIsAdmin(r, 'bob', { destructive: true }), true);
  assert.equal(acl, 0, 'no ACL refresh was needed');
  clearTimeout(c.backupTimer);
});

test('an ACL fetch that fails leaves the advisory gate open and the destructive one shut', async () => {
  // Offline is exactly when roles cannot be established, so this is the
  // realistic version of "unknown" rather than an exotic one.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  const r = record({ roles: {} });
  c.servers.set('srv', r);
  assert.equal(await c.senderIsAdmin(r, 'ghost'), true);
  assert.equal(await c.senderIsAdmin(r, 'ghost', { destructive: true }), false);
  clearTimeout(c.backupTimer);
});

/* --- channelDigest: the home base's unread counts ------------------------ */

/** A relay that answers unread counts from a {hid: n} table. */
function countingRelay(counts) {
  return (msg) =>
    msg.t === 'history_counts'
      ? Promise.resolve({
          counts: msg.logs.map(({ hid }) => ({ hid, n: counts[hid] ?? 0 })),
        })
      : Promise.resolve({ seq: 1 });
}

test('channelDigest asks the relay what this device has missed, per room', async () => {
  // A device holds no messages, so it cannot count them. The relay can: it
  // knows how many entries each log has, when they landed, and who wrote
  // them — and it excludes the caller's own, which are read by definition.
  const { c } = makeController({ relayHandler: countingRelay({ h_gen: 1, h_des: 1 }) });
  const r = record({
    channels: ['general', 'design'],
    seen: { general: 150 },
    joinedAt: 100,
    chanMeta: { general: { hid: 'h_gen' }, design: { hid: 'h_des' } },
  });
  c.servers.set('srv', r);
  // Whatever this session has read back is what the preview quotes.
  seed(c, { sender: 'alice', ts: 300, text: 'mine' });

  const digest = await c.channelDigest('srv');
  const general = digest.find((d) => d.channel === 'general');
  assert.equal(general.unread, 1);
  assert.equal(general.last.text, 'mine', 'the preview is the newest line this device has');

  const design = digest.find((d) => d.channel === 'design');
  assert.equal(design.unread, 1, 'a never-opened room still gets a count');
  assert.equal(design.last, null, 'without a preview — it has not been read back yet');

  // The cursor the relay is given is the seen marker, in seconds.
  const asked = c.relay.requests.find((m) => m.t === 'history_counts');
  assert.deepEqual(
    asked.logs.find((l) => l.hid === 'h_gen'),
    { hid: 'h_gen', after_ts: 0 },
    'seen 150ms floors to second 0'
  );
});

test('channelDigest reports an empty room rather than omitting it', async () => {
  // The home base lists every room; a missing entry would render as a gap.
  const { c } = makeController({ relayHandler: countingRelay({}) });
  const r = record({ channels: ['general'], chanMeta: { general: { hid: 'h1' } } });
  c.servers.set('srv', r);
  const [only] = await c.channelDigest('srv');
  assert.equal(only.channel, 'general');
  assert.equal(only.unread, 0);
  assert.equal(only.last, null);
});

test('channelDigest ignores system chips', async () => {
  // "carol joined" is this device's own notice, never in the log — so it can
  // neither light up the home base nor become its preview.
  const { c } = makeController({ relayHandler: countingRelay({ h1: 0 }) });
  const r = record({ seen: {}, joinedAt: 0, chanMeta: { general: { hid: 'h1' } } });
  c.servers.set('srv', r);
  c.addSystemMessage('srv', 'joined', 'general');
  const [general] = await c.channelDigest('srv');
  assert.equal(general.unread, 0);
  assert.equal(general.last, null, 'and it is not the preview either');
});

test('a circle unread total sums its rooms, and survives an unreachable relay', async () => {
  const { c } = makeController({ relayHandler: countingRelay({ h_gen: 2, h_des: 3 }) });
  c.servers.set(
    'srv',
    record({
      channels: ['general', 'design'],
      chanMeta: { general: { hid: 'h_gen' }, design: { hid: 'h_des' } },
    })
  );
  assert.deepEqual(await c.circleUnreads(), { srv: 5 });

  const offline = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_counts' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  offline.c.servers.set('srv', record({ chanMeta: { general: { hid: 'h_gen' } } }));
  assert.deepEqual(await offline.c.circleUnreads(), { srv: 0 }, 'no badge rather than no rail');
});

test('channelDigest on an unknown circle is empty, not an exception', async () => {
  const { c } = makeController();
  assert.deepEqual(await c.channelDigest('gone'), []);
});

/* --- the relay refusing a write ------------------------------------------ */

test('a channel whose log fetch fails renders empty rather than throwing', async () => {
  // With no local copy, an unreachable relay means an empty room. It must
  // not take the pane down with it.
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'history_fetch' ? Promise.reject(new Error('offline')) : Promise.resolve({ seq: 1 }),
  });
  const hkey = b64.enc(new Uint8Array(32));
  const r = record({ chanMeta: { general: { hid: 'h1', hkey } } });
  c.servers.set('srv', r);

  assert.deepEqual(await c.loadMessages('srv', 'general'), []);
  clearTimeout(c.backupTimer);
});

// --- fork detection (plan §1.1, part 4) ----------------------------------
// §1.1 stopped new forks with the relay-side epoch CAS. Circles that forked
// BEFORE it landed stayed broken with, in the plan's words, "no detection
// and no recovery path" — the only trace was a console warning whose own
// comment calls it expected. These cover the wiring; fork.test.mjs covers
// the rule.

/** Drive `n` undecryptable blobs from `sender` into a live circle. */
async function blobs(c, n, { sender = 'bob', epoch = 1, from = 10 } = {}) {
  c.crypto = async (cmd) => {
    if (cmd === 'receive') throw new Error('no matching key');
    return {};
  };
  for (let i = 0; i < n; i++) {
    await c.onGroupMessage({ group: 'srv', seq: from + i, epoch, sender, payload: 'AAAA' });
  }
}

test('a circle whose every sender is unreadable is reported as forked', async () => {
  const { c, dispatched } = makeController();
  c.servers.set('srv', record({ name: 'Book Club' }));

  await blobs(c, FORK_THRESHOLD);

  const toast = dispatched.find((a) => a.type === 'toast' && /out of sync/.test(a.text ?? ''));
  assert.ok(toast, 'the user is told, rather than watching the circle go quiet');
  assert.match(toast.text, /Book Club/);
  assert.match(toast.text, /invite link/, 'and told the one thing that actually recovers it');
  assert.equal(c.servers.get('srv').outOfSync, true, 'the record carries it for the UI');
  clearTimeout(c.backupTimer);
});

test('our own replayed commits never trip the detector', async () => {
  // The false positive that matters: catch-up hands every device back its
  // own commits, so counting these would flag every healthy circle in the
  // app. Ten times the threshold, and still silent.
  const { c, dispatched } = makeController();
  c.servers.set('srv', record());

  await blobs(c, FORK_THRESHOLD * 10, { sender: 'alice' });

  assert.equal(
    dispatched.filter((a) => a.type === 'toast').length,
    0,
    'no toast for the most common undecryptable blob there is'
  );
  assert.ok(!c.servers.get('srv').outOfSync);
  clearTimeout(c.backupTimer);
});

test('blobs from an epoch we have not caught up to yet are not a fork', async () => {
  const { c, dispatched } = makeController();
  c.servers.set('srv', record({ epoch: 1 }));

  await blobs(c, FORK_THRESHOLD * 3, { sender: 'bob', epoch: 9 });

  assert.equal(dispatched.filter((a) => a.type === 'toast').length, 0);
  clearTimeout(c.backupTimer);
});

test('a restored read-only stub is not mistaken for a fork', async () => {
  // It holds no MLS state, so nothing decrypts — by design, not by breakage.
  const { c, dispatched } = makeController();
  c.servers.set('srv', record({ restored: true }));

  await blobs(c, FORK_THRESHOLD * 3);

  assert.equal(dispatched.filter((a) => a.type === 'toast').length, 0);
  clearTimeout(c.backupTimer);
});

test('one message getting through clears the suspicion it had built up', async () => {
  const { c, dispatched } = makeController();
  c.servers.set('srv', record());

  await blobs(c, FORK_THRESHOLD - 1);
  c.crypto = async (cmd) =>
    cmd === 'receive'
      ? { event: { kind: 'message', sender: 'bob', text: 'hi', epoch: 1 }, state: null }
      : {};
  await c.onGroupMessage({ group: 'srv', seq: 30, epoch: 1, sender: 'bob', payload: 'AAAA' });
  await blobs(c, FORK_THRESHOLD - 1, { from: 40 });

  assert.equal(dispatched.filter((a) => a.type === 'toast').length, 0, 'the counter restarted');
  clearTimeout(c.backupTimer);
});

test('the fork notice is raised once, not on every blob from the other branch', async () => {
  const { c, dispatched } = makeController();
  c.servers.set('srv', record());

  await blobs(c, FORK_THRESHOLD * 4);

  assert.equal(
    dispatched.filter((a) => a.type === 'toast').length,
    1,
    'repeating it on every message would be its own kind of broken'
  );
  clearTimeout(c.backupTimer);
});

test('leaving a circle clears its fork evidence so a rejoin starts clean', async () => {
  // Otherwise the old branch's tally would immediately re-condemn the new
  // membership, and the recovery the notice recommends would look like it
  // had failed.
  const { c } = makeController();
  c.servers.set('srv', record());
  await blobs(c, FORK_THRESHOLD);
  assert.equal(c.forks.verdict('srv').outOfSync, true);

  await c.forgetServerLocal('srv');

  assert.deepEqual(c.forks.verdict('srv'), { stranded: [], outOfSync: false });
  assert.equal(c.forkWarned.size, 0, 'and it may warn again if it recurs');
  clearTimeout(c.backupTimer);
});

/* ---------------------------------------------------- when to park it -- */
// The blob is the only copy of the circles, so *when* it is written is not a
// tuning question. These cover the two holes a plain 3s debounce had, both of
// which ended with a device reloading into an empty circles home.

/** The delay on the pending park. Node clamps setTimeout(fn, 0) to 1ms, so
    "no wait" is <= 1 rather than 0. */
function parkWait(c) {
  return c.backupTimer?._idleTimeout ?? Infinity;
}

/** Park scheduling without waiting on real time: run the pending timer now. */
function runPendingBackup(c) {
  const t = c.backupTimer;
  if (!t) return null;
  clearTimeout(t);
  c.backupTimer = null;
  return c.flushBackup();
}

test('a change to what a circle IS parks at once, not after a debounce', async () => {
  // You are added to a circle. The welcome carries no name, so the record
  // starts out called after its own group id, and the name and rooms arrive
  // moments later on the meta rebroadcast. Under a pure debounce every timer
  // that would have parked *that* was still pending when the page reloaded —
  // and a reload cancels timers.
  const writes = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      if (msg.t === 'backup_set') writes.push(msg.payload);
      return Promise.resolve({ seq: 1, version: writes.length });
    },
  });
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;

  c.servers.set('srv', record({ id: 'srv', name: 'srv-2mlp' }));
  c.scheduleBackup();
  assert.ok(parkWait(c) <= 1, 'a new circle waits for nothing');
  await runPendingBackup(c);
  assert.equal(writes.length, 1);

  // The name lands. Still structural: park it now.
  c.servers.get('srv').name = 'Race Team';
  c.scheduleBackup();
  assert.ok(parkWait(c) <= 1, 'a rename waits for nothing');
  await runPendingBackup(c);
  assert.equal(writes.length, 2);

  // A room appears. Also structural.
  c.servers.get('srv').channels = ['general', 'logistics'];
  c.scheduleBackup();
  assert.ok(parkWait(c) <= 1, 'a new room waits for nothing');
  await runPendingBackup(c);

  const opened = await openBackup(c.identityBytes(), writes.at(-1));
  assert.equal(opened.servers[0].name, 'Race Team');
  assert.deepEqual(opened.servers[0].channels, ['general', 'logistics']);
  clearTimeout(c.backupTimer);
});

test('chatter about a settled shape debounces, but never past the ceiling', async () => {
  const { c } = makeController({
    relayHandler: () => Promise.resolve({ seq: 1, version: 1 }),
  });
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;
  c.servers.set('srv', record({ id: 'srv', name: 'Race Team' }));
  c.scheduleBackup();
  await runPendingBackup(c);

  // Same shape, new content: this is what debouncing is for.
  c.servers.get('srv').notices = [{ id: 'n1', text: 'hi', ts: 1, author: 'bob' }];
  c.scheduleBackup();
  const first = parkWait(c);
  assert.ok(first > 0, 'a notice does not need its own upload');

  // A circle that is busy for longer than the debounce used to reset the
  // timer forever and never park at all. The wait is measured from the first
  // pending change, so it only ever shrinks.
  c.backupPendingSince = Date.now() - 7000;
  c.servers.get('srv').notices.push({ id: 'n2', text: 'again', ts: 2, author: 'bob' });
  c.scheduleBackup();
  assert.ok(
    parkWait(c) < first,
    'the ceiling is measured from the first pending change, not the last',
  );
  clearTimeout(c.backupTimer);
});

test('two structural changes in a row do not race on the version', async () => {
  // "Park at once" would otherwise let each change start its own upload;
  // they swap against the same version and all but one lose it.
  let inFlight = 0;
  let maxConcurrent = 0;
  const { c } = makeController({
    relayHandler: async (msg) => {
      if (msg.t !== 'backup_set') return { seq: 1 };
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { seq: 1, version: 1 };
    },
  });
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;

  c.servers.set('a', record({ id: 'a', name: 'A' }));
  const run = c.flushBackup();
  c.servers.set('b', record({ id: 'b', name: 'B' }));
  c.scheduleBackup();
  assert.equal(c.backupTimer, null, 'the second change waits for the first upload to land');
  await run;
  await runPendingBackup(c);
  assert.equal(maxConcurrent, 1, 'uploads are serialized');
  clearTimeout(c.backupTimer);
});

test('being the first into a voice room starts a call rather than throwing', async () => {
  // The line that announces a call is device-local and synchronous — it
  // returns nothing. A `.catch(() => {})` on it threw a TypeError instead of
  // swallowing one, from inside track(), from inside join(), so the first
  // person into a room got a toast and no call. Every call starts with
  // somebody being first, so this was every call.
  const { c } = makeController();
  c.servers.set('srv', record({ id: 'srv', name: 'Race Team', channels: ['general'] }));
  assert.doesNotThrow(() => c.announceCallStarted('srv', 'lounge', 'alice'));
  const said = renderLog(c.channelLog('srv', 'general')).filter((m) => m.system);
  assert.ok(
    said.some((m) => m.text === 'you started a call in lounge'),
    'the room says who opened the call',
  );
});

/* ------------------------------------------- what survives a bad moment -- */
// The relay's blob is where circles live, but the write to it is debounced
// and needs a socket. Everything below is about the window before it lands:
// a reload inside it used to cost a device a room key, or a whole circle,
// with nothing to say so.

/** A database that actually keeps what it is given. */
function memoryDb(initial = {}) {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    kvPut: async (key, value) => void kv.set(key, value),
    kvGet: async (key) => kv.get(key) ?? null,
  };
}

const KEY_A = b64.enc(new Uint8Array(32).fill(1));
const KEY_B = b64.enc(new Uint8Array(32).fill(2));

test('a change is written down on the device before the relay has it', async () => {
  const { c } = makeController();
  c.db = memoryDb();
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;
  c.servers.set('srv', record({ chanMeta: { general: { hid: 'h', hkey: KEY_A } } }));
  c.scheduleBackup();
  await Promise.resolve();
  const staged = c.db.kv.get('pendingCircles');
  assert.equal(staged.servers[0].chanMeta.general.hkey, KEY_A, 'the room key is staged');

  // …and the note goes once the relay has acknowledged a blob holding it.
  await runPendingBackup(c);
  assert.equal(c.db.kv.get('pendingCircles'), null);
  clearTimeout(c.backupTimer);
});

test('a failed upload leaves the note in place', async () => {
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_set' ? Promise.reject(new Error('the connection dropped')) : Promise.resolve({ seq: 1 }),
  });
  c.db = memoryDb();
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;
  c.servers.set('srv', record());
  c.scheduleBackup();
  await runPendingBackup(c);
  assert.ok(c.db.kv.get('pendingCircles')?.servers?.length, 'still staged after the relay refused');
  clearTimeout(c.backupTimer);
});

test('a later change is not cleared by an earlier upload landing', async () => {
  let release;
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'backup_set'
        ? new Promise((resolve) => (release = () => resolve({ version: 1 })))
        : Promise.resolve({ seq: 1 }),
  });
  c.db = memoryDb();
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.circlesLoaded = true;
  c.servers.set('srv', record());
  const first = c.flushBackup();
  // Arrives while the first upload is in the air, so that blob lacks it.
  await new Promise((r) => setTimeout(r, 5));
  c.servers.get('srv').chanMeta = { general: { hid: 'h', hkey: KEY_A } };
  c.scheduleBackup();
  release();
  await first;
  assert.equal(
    c.db.kv.get('pendingCircles')?.servers?.[0]?.chanMeta?.general?.hkey,
    KEY_A,
    'the key the upload did not carry is still staged'
  );
  clearTimeout(c.backupTimer);
});

test('a reload inside the window gets back what was staged, folded into the blob', async () => {
  // Last session: the room key for #general arrived and the tab reloaded
  // before it was parked. The relay's blob still has the circle without it.
  const identity = new Uint8Array(32).fill(7);
  const parked = await sealBackup(identity, {
    v: 2,
    servers: [
      { id: 'srv', name: 'Race Team', channels: ['general'], chanMeta: {} },
      { id: 'other', name: 'Photo Club', channels: ['general'], chanMeta: { general: { hid: 'o', hkey: KEY_B } } },
    ],
  });
  const { c } = makeController({
    relayHandler: (msg) =>
      Promise.resolve(msg.t === 'backup_get' ? { payload: parked, version: 3 } : { seq: 1, version: 4 }),
  });
  c.db = memoryDb({
    pendingCircles: {
      rev: 9,
      servers: [{ id: 'srv', name: 'Race Team', channels: ['general'], chanMeta: { general: { hid: 'h', hkey: KEY_A } } }],
      left: [],
    },
  });
  c.identityBytes = () => identity;
  await c.loadDeviceState();
  await c.readCircles();
  assert.equal(c.servers.get('srv').chanMeta.general.hkey, KEY_A, 'the staged key is back');
  assert.ok(c.servers.has('other'), 'and nothing the relay had is lost to it');
  assert.ok(c.backupDirty, 'the merged result is on its way to the relay');
  clearTimeout(c.backupTimer);
});

test('a circle left in that window stays left', async () => {
  const identity = new Uint8Array(32).fill(7);
  const parked = await sealBackup(identity, { v: 2, servers: [{ id: 'gone', name: 'Left', channels: ['general'] }] });
  const { c } = makeController({
    relayHandler: (msg) =>
      Promise.resolve(msg.t === 'backup_get' ? { payload: parked, version: 1 } : { seq: 1, version: 2 }),
  });
  c.db = memoryDb({ pendingCircles: { rev: 2, servers: [], left: ['gone'] } });
  c.identityBytes = () => identity;
  await c.loadDeviceState();
  await c.readCircles();
  assert.ok(!c.servers.has('gone'), 'a blob that predates the leave does not bring it back');
  clearTimeout(c.backupTimer);
});

test('a reconnect folds in room keys another device parked', async () => {
  const identity = new Uint8Array(32).fill(7);
  const parked = await sealBackup(identity, {
    v: 2,
    servers: [{ id: 'srv', name: 'circle', channels: ['general'], chanMeta: { general: { hid: 'h', hkey: KEY_B, hkeys: [KEY_A], kv: 1 } } }],
  });
  const { c } = makeController({
    relayHandler: (msg) =>
      Promise.resolve(msg.t === 'backup_get' ? { payload: parked, version: 5 } : { seq: 1, version: 6 }),
  });
  c.db = memoryDb();
  c.identityBytes = () => identity;
  c.mlsGroups = new Set(['srv']);
  // Held in memory from before the socket dropped, with the pre-rotation key.
  c.servers.set('srv', record({ chanMeta: { general: { hid: 'h', hkey: KEY_A } } }));
  await c.readCircles();
  assert.equal(c.servers.get('srv').chanMeta.general.hkey, KEY_B);
  assert.deepEqual(c.servers.get('srv').chanMeta.general.hkeys, [KEY_A]);
  clearTimeout(c.backupTimer);
});

test('a ratchet with no circle record is rebuilt as a stub, and asks', async () => {
  // The known failure: added to a circle, reloaded before the blob was
  // written, and the circle was simply absent afterwards — still a member,
  // still holding the ratchet, with nothing on screen.
  const { c } = makeController({
    relayHandler: (msg) => Promise.resolve(msg.t === 'backup_get' ? { payload: null, version: 0 } : { seq: 1, version: 1 }),
  });
  c.db = memoryDb();
  c.identityBytes = () => new Uint8Array(32).fill(7);
  c.mlsGroups = new Set(['race-team-x1']);
  await c.readCircles();
  const stub = c.servers.get('race-team-x1');
  assert.ok(stub, 'the circle is back');
  assert.ok(!stub.restored, 'and it can send — the ratchet is what says so');
  assert.equal(c.needsMeta(stub), true);

  c.crypto = async (cmd) =>
    cmd === 'memberKeys' ? { alice: new Uint8Array(32), bob: new Uint8Array(32) } : { blob: new Uint8Array(1), epoch: 1 };
  const sent = [];
  c.sendContent = async (_id, content) => void sent.push(content);
  await c.requestMeta(stub);
  assert.deepEqual(sent, [{ k: 'meta-req' }]);
  clearTimeout(c.backupTimer);
});

test('a metadata request is answered once, and not after someone else answers', async () => {
  const { c } = makeController();
  const r = record({ chanMeta: { general: { hid: 'h', hkey: KEY_A } } });
  c.servers.set('srv', r);
  await c.onContent(r, 'bob', JSON.stringify({ k: 'meta-req' }));
  await c.onContent(r, 'bob', JSON.stringify({ k: 'meta-req' }));
  assert.equal(c.metaReplies.size, 1, 'one pending answer however many times it is asked');

  // carol's snapshot arrives first: ours would be a repeat.
  await c.onContent(r, 'carol', JSON.stringify({ k: 'meta', name: 'circle', channels: ['general'] }));
  assert.equal(c.metaReplies.size, 0);

  // A device still waiting on its own first snapshot has nothing to offer.
  r.pendingMetaSync = true;
  await c.onContent(r, 'bob', JSON.stringify({ k: 'meta-req' }));
  assert.equal(c.metaReplies.size, 0);
  clearTimeout(c.backupTimer);
});

test('deleting a circle removes every member, one accepted commit at a time', async () => {
  // It used to publish the first removal without marking it a commit and
  // never merge it — so the second removal was refused for the pending one,
  // and everyone past the first member kept a working ratchet.
  const calls = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      calls.push(msg.t === 'send' ? `send${msg.commit ? ':commit' : ''}` : msg.t);
      return Promise.resolve({ seq: calls.length });
    },
  });
  let epoch = 3;
  c.crypto = async (cmd, args) => {
    calls.push(cmd === 'removeMember' ? `remove:${args.name}` : cmd);
    if (cmd === 'removeMember') return { commit: new Uint8Array([1]), epoch: epoch + 1, state: null };
    if (cmd === 'mergeStagedCommit') return { epoch: ++epoch, members: ['alice'], state: null };
    return { state: null };
  };
  c.servers.set('srv', record({ members: ['alice', 'bob', 'carol'], epoch }));
  await c.deleteServer('srv');
  assert.deepEqual(calls.slice(0, 7), [
    'remove:bob',
    'send:commit',
    'mergeStagedCommit',
    'remove:carol',
    'send:commit',
    'mergeStagedCommit',
    'delete_group',
  ]);
  assert.ok(!c.servers.has('srv'));
  clearTimeout(c.backupTimer);
});

test('blobs are applied in order, so the newest ratchet is the one left on disk', async () => {
  // The first blob's handler needs the relay (an admin check) and so
  // finishes after the second's. Each ends by writing the ratchet snapshot
  // it was handed; unqueued, the first — older — snapshot was written last.
  let releaseRoles;
  const { c } = makeController({
    relayHandler: (msg) =>
      msg.t === 'members'
        ? new Promise((resolve) => (releaseRoles = () => resolve({ members: [{ user: 'bob', role: 'admin' }] })))
        : Promise.resolve({ seq: 1 }),
  });
  const written = [];
  c.db = { kvGet: async () => null, kvPut: async (k, v) => void (k === 'mlsState' && written.push(v)) };
  const opened = [];
  c.crypto = async (cmd, args) => {
    if (cmd !== 'receive') return {};
    const n = args.bytes[0];
    opened.push(n);
    const text = n === 1
      ? JSON.stringify({ k: 'overview', ov: { blurb: 'slow: needs an admin check' } })
      : JSON.stringify({ k: 'chat', ch: 'general', text: 'fast', ts: 5 });
    return { event: { kind: 'message', sender: 'bob', text }, state: `ratchet-after-${n}` };
  };
  c.servers.set('srv', record({ roles: {} }));
  const first = c.onGroupMessage({ group: 'srv', seq: 1, epoch: 1, sender: 'bob', payload: b64.enc(new Uint8Array([1])) });
  const second = c.onGroupMessage({ group: 'srv', seq: 2, epoch: 1, sender: 'bob', payload: b64.enc(new Uint8Array([2])) });
  assert.deepEqual(opened, [1, 2], 'decryption starts at once, in arrival order');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(written, [], 'the second does not overtake the first');
  releaseRoles();
  await Promise.all([first, second]);
  assert.deepEqual(written, ['ratchet-after-1', 'ratchet-after-2']);
  clearTimeout(c.backupTimer);
});

/* ------------------------------------------------ an account's devices -- */
// Each device is its own MLS leaf. Adding a person takes a KeyPackage from
// every device they use; a device that signs in later asks the circle to
// let it in, and any member may — the crypto core checks the certificate.

/** A crypto stub that records what it was asked to add. */
function addingCrypto({ devices = [], roster = {} } = {}) {
  const calls = [];
  const fn = async (cmd, args = {}) => {
    calls.push({ cmd, ...args });
    if (cmd === 'memberDevices') return devices;
    if (cmd === 'memberKeys') return roster;
    if (cmd === 'addMember') return { commit: new Uint8Array([1]), welcome: new Uint8Array([9]), epoch: 4, state: null };
    if (cmd === 'mergeStagedCommit') return { epoch: 4, members: ['alice', 'bob'], state: null };
    if (cmd === 'send') return { blob: new Uint8Array([1]), epoch: 4, state: null };
    return {};
  };
  fn.calls = calls;
  return fn;
}

test('adding a person adds every device they have, in one commit', async () => {
  const sent = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      sent.push(msg);
      if (msg.t === 'fetch_kps') {
        return Promise.resolve({
          pubkey: b64.enc(new Uint8Array(32).fill(5)),
          packages: [
            { device: 'laptop', payload: b64.enc(new Uint8Array([1])) },
            { device: 'phone', payload: b64.enc(new Uint8Array([2])) },
          ],
        });
      }
      if (msg.t === 'members') return Promise.resolve({ members: [] });
      return Promise.resolve({ seq: 7 });
    },
  });
  c.crypto = addingCrypto();
  c.servers.set('srv', record({ members: ['alice'] }));
  await c.addMember('srv', 'bob');

  const adds = c.crypto.calls.filter((x) => x.cmd === 'addMember');
  assert.equal(adds.length, 1, 'one commit');
  assert.equal(adds[0].keyPackages.length, 2, 'carrying both devices');
  assert.equal(adds[0].expectIdentity, 'bob');
  // One Welcome each, addressed, so the phone's waits for the phone.
  const welcomes = sent.filter((m) => m.t === 'welcome');
  assert.deepEqual(welcomes.map((w) => [w.to, w.device]), [['bob', 'laptop'], ['bob', 'phone']]);
  assert.ok(sent.findIndex((m) => m.t === 'send' && m.commit) < sent.findIndex((m) => m.t === 'welcome'));
  clearTimeout(c.backupTimer);
});

test('an account whose devices are unnamed is still added the old way', async () => {
  const sent = [];
  const { c } = makeController({
    relayHandler: (msg) => {
      sent.push(msg);
      if (msg.t === 'fetch_kps') return Promise.resolve({ packages: [], pubkey: 'AAAA' });
      if (msg.t === 'fetch_kp') return Promise.resolve({ payload: b64.enc(new Uint8Array([3])), pubkey: 'AAAA' });
      if (msg.t === 'members') return Promise.resolve({ members: [] });
      return Promise.resolve({ seq: 7 });
    },
  });
  c.crypto = addingCrypto();
  c.servers.set('srv', record({ members: ['alice'] }));
  await c.addMember('srv', 'bob');
  const welcome = sent.find((m) => m.t === 'welcome');
  assert.equal(welcome.device, undefined, 'unaddressed: any device of theirs may open it');
  clearTimeout(c.backupTimer);
});

test('a read-only device asks for a seat, and does not nag', async () => {
  const sent = [];
  const { c } = makeController({ relayHandler: (msg) => (sent.push(msg), Promise.resolve({ seq: 1 })) });
  const r = record({ restored: true });
  c.servers.set('srv', r);
  await c.requestSeat(r);
  await c.requestSeat(r);
  assert.deepEqual(sent.map((m) => m.t), ['device_join'], 'once per window, however often it is prompted');

  // A device that can already send has nothing to ask for.
  const live = record({ id: 'other' });
  c.servers.set('other', live);
  await c.requestSeat(live);
  assert.equal(sent.length, 1);
});

test('any member lets a member’s new device in, against the circle’s own key for them', async () => {
  const sent = [];
  const circleKey = new Uint8Array(32).fill(4);
  const { c } = makeController({
    relayHandler: (msg) => {
      sent.push(msg);
      if (msg.t === 'fetch_kps') {
        return Promise.resolve({
          // The relay's idea of bob's key is deliberately NOT what gets used.
          pubkey: b64.enc(new Uint8Array(32).fill(9)),
          packages: [{ device: msg.device, payload: b64.enc(new Uint8Array([2])) }],
        });
      }
      return Promise.resolve({ seq: 7 });
    },
  });
  c.crypto = addingCrypto({ devices: [{ name: 'bob', key: new Uint8Array([1, 1]) }], roster: { bob: circleKey } });
  c.servers.set('srv', record());

  assert.equal(await c.admitDevice('srv', 'bob', 'phone'), true);
  const add = c.crypto.calls.find((x) => x.cmd === 'addMember');
  assert.deepEqual([...add.expectKey], [...circleKey], 'authorized by the key the circle holds, not the relay');
  assert.equal(sent.find((m) => m.t === 'fetch_kps').device, 'phone');
  const welcome = sent.find((m) => m.t === 'welcome');
  assert.deepEqual([welcome.to, welcome.device], ['bob', 'phone']);
  clearTimeout(c.backupTimer);
});

test('a device is not added twice, nor for someone who is not in the circle', async () => {
  const { c } = makeController();
  const bobsPhone = new Uint8Array([7, 7, 7]);
  const name = Buffer.from(bobsPhone).toString('base64url');
  c.crypto = addingCrypto({ devices: [{ name: 'bob', key: bobsPhone }], roster: { bob: new Uint8Array(32) } });
  c.servers.set('srv', record());
  assert.equal(await c.admitDevice('srv', 'bob', name), false, 'already in');
  assert.equal(c.crypto.calls.some((x) => x.cmd === 'addMember'), false);

  // carol was removed (or never joined): the roster has no key for her, so
  // asking is not a way back in.
  assert.equal(await c.admitDevice('srv', 'carol', 'tablet'), false);
  assert.equal(c.crypto.calls.some((x) => x.cmd === 'addMember'), false);

  // And a device that is itself read-only has no ratchet to add with.
  c.servers.set('ro', record({ id: 'ro', restored: true }));
  assert.equal(await c.admitDevice('ro', 'bob', 'tablet'), false);
});

test('being let in keeps what the account’s copy of the circle already held', async () => {
  const { c } = makeController();
  c.db = memoryDb();
  c.crypto = async (cmd) =>
    cmd === 'joinFromWelcome' ? { group: 'srv', epoch: 5, members: ['alice', 'bob'], state: null } : {};
  c.servers.set(
    'srv',
    record({
      restored: true,
      name: 'Race Team',
      keys: { bob: 'bobs-identity-key' },
      invites: [{ id: 'inv', key: 'frag' }],
      chanMeta: { general: { hid: 'h', hkey: KEY_A } },
    })
  );
  await c.onWelcome({ group: 'srv', after: 9, payload: b64.enc(new Uint8Array([1])) });
  const r = c.servers.get('srv');
  assert.ok(!r.restored, 'it can send now');
  assert.deepEqual(r.keys, { bob: 'bobs-identity-key' }, 'the key directory survives');
  assert.deepEqual(r.invites, [{ id: 'inv', key: 'frag' }], 'and so do invite keys the other device relies on');
  assert.equal(r.chanMeta.general.hkey, KEY_A);
  clearTimeout(c.backupTimer);
});

test('a write the relay cannot take yet waits for a load instead of spinning', async () => {
  // No blob has been read, so the upload declines. It used to reschedule
  // itself at once — and since nothing was ever parked, "at once" meant
  // 0ms, forever, for as long as the relay could not serve the blob.
  let uploads = 0;
  const { c } = makeController();
  c.db = memoryDb();
  c.identityBytes = () => new Uint8Array(32).fill(7);
  const upload = c.uploadBackup.bind(c);
  c.uploadBackup = async () => (uploads++, upload());
  c.servers.set('srv', record());
  c.scheduleBackup();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(uploads, 1, 'asked once, declined, and left alone');
  assert.equal(c.backupDirty, true, 'still owed');
  assert.ok(c.db.kv.get('pendingCircles')?.servers?.length, 'and still written down on the device');
});

test('a global admin can purge a circle by id, whether or not this device holds it', async () => {
  const sent = [];
  const { c } = makeController({ relayHandler: (msg) => (sent.push(msg), Promise.resolve({ seq: 1 })) });
  c.db = memoryDb();
  // One this account is in, and one it has never seen.
  c.servers.set('mine', record({ id: 'mine', name: 'Mine' }));
  c.mlsGroups = new Set(['mine']);
  await c.adminDeleteGroup('someone-elses');
  await c.adminDeleteGroup('mine');
  assert.deepEqual(
    sent.filter((m) => m.t === 'delete_group').map((m) => m.group),
    ['someone-elses', 'mine']
  );
  assert.ok(!c.servers.has('mine'), 'its own copy goes with it');
  // No MLS removal is attempted: there may be no working ratchet to do it
  // with, which is the situation this exists for.
  assert.ok(!sent.some((m) => m.t === 'send'));
  clearTimeout(c.backupTimer);
});

/* ------------------------------------------- registering is deliberate -- */

test('only a sign-up or a hand-made restore asks the relay to create an account', async () => {
  const { c } = makeController();
  c.db = memoryDb();
  c.crypto = async (cmd) => (cmd === 'exportIdentity' ? new Uint8Array(4) : { name: 'michael', groups: [], state: null });
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

  assert.notEqual(c.registering, true, 'a controller that has done nothing is not registering');
  await c.createIdentity('michael');
  assert.equal(c.registering, true, 'signing up is');
  assert.equal(c.db.kv.get('registering'), true, 'and it survives a reload before the first connection');

  // The relay accepted it: every connection after this is a reconnection.
  c.loadCircles = async () => [];
  c.voice = { probe() {} };
  c.relay.request = async () => ({ servers: '[]', seq: 1 });
  await c.onRelayEvent({ t: 'ready' }).catch(() => {});
  assert.equal(c.registering, false);
  assert.equal(c.db.kv.get('registering'), false);

  // The app recovering an identity by itself is nobody asking for an account…
  await c.restoreIdentity(new Uint8Array(4), { explicit: false });
  assert.equal(c.registering, false);
  // …a person restoring one is.
  await c.restoreIdentity(new Uint8Array(4));
  assert.equal(c.registering, true);
  clearTimeout(c.backupTimer);
});

test('a relay that no longer knows the account sends the session to the gate, keeping the key', async () => {
  const { c, dispatched } = makeController();
  c.db = memoryDb({ session: { name: 'michael' } });
  let removed = false;
  globalThis.localStorage = { getItem: () => 'key', setItem() {}, removeItem: () => void (removed = true) };
  c.me = 'michael';
  await c.onAuthRejected('unknown account on this relay');
  assert.match(c.authError, /no account for "michael"/);
  assert.match(c.authError, /may have been reset/);
  assert.equal(removed, false, 'the identity is not wiped: it may be the only copy of a key somebody wants');
  assert.deepEqual(dispatched.at(-1), { type: 'phase', phase: 'onboarding' });
});

test('a new account starts without what an earlier one on this device left behind', async () => {
  const { c } = makeController();
  c.db = memoryDb({ deviceState: { old: { lastSeq: 9 } }, pendingCircles: { rev: 1, servers: [{ id: 'old' }], left: [] } });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  c.crypto = async (cmd) => (cmd === 'exportIdentity' ? new Uint8Array(4) : { name: 'michael', groups: [], state: null });
  await c.loadDeviceState();
  assert.ok(c.pendingCarry, 'the earlier account had staged a circle');
  await c.createIdentity('michael');
  assert.equal(c.pendingCarry, null);
  assert.deepEqual(c.db.kv.get('deviceState'), {});
  assert.equal(c.db.kv.get('pendingCircles'), null);
});
