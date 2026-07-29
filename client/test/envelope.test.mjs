// The protocol's semantic core, tested without a relay, a worker or a
// database — which is the whole point of plan §2.2. These rules decide who
// may delete a channel and whose edit lands on whose message; before the
// extraction none of them could be reached except by standing up the whole
// stack, so most of them had no direct coverage at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminRequirement,
  applyEnvelope,
  parseEnvelope,
  DELETED_MAX,
  markChannelDeleted,
} from '../src/lib/envelope.js';

const NOW = 1_800_000_000_000;

/** A circle record in its ordinary shape. */
function circle(over = {}) {
  return {
    id: 'srv',
    name: 'Test Circle',
    channels: ['general'],
    voiceChannels: ['lounge'],
    chanMeta: {},
    roles: {},
    ...over,
  };
}

/** Apply one envelope as an admin unless told otherwise. */
function apply(record, content, { sender = 'bob', isAdmin = true, inCall = null } = {}) {
  return applyEnvelope(record, sender, content, { isAdmin, now: NOW, inCall });
}

const kinds = (effects) => effects.map((e) => e.t);
const find = (effects, t) => effects.find((e) => e.t === t);

/* ------------------------------------------------------------- parsing -- */

test('a non-JSON payload is read as a plain chat line', () => {
  // The oldest wire shape, and still what a hand-rolled client would send.
  assert.deepEqual(parseEnvelope('hello there'), {
    k: 'chat',
    ch: 'general',
    text: 'hello there',
  });
});

test('a JSON payload is parsed as itself', () => {
  assert.deepEqual(parseEnvelope('{"k":"chan","ch":"design"}'), { k: 'chan', ch: 'design' });
});

/* -------------------------------------------------------- the admin gate -- */

test('destructive kinds are the ones that reach deletion or the crypto settings', () => {
  // This table IS the authorization model. A kind missing from it is a kind
  // anyone in the circle can send, so it is asserted explicitly rather than
  // left to the switch statement that consumes it.
  for (const k of ['chanset', 'chan-ren', 'chan-del', 'vchan-ren', 'vchan-del']) {
    assert.deepEqual(adminRequirement({ k }), { destructive: true }, k);
  }
  for (const k of ['chan', 'vchan', 'overview']) {
    assert.deepEqual(adminRequirement({ k }), { destructive: false }, k);
  }
  for (const k of ['chat', 'file', 'game', 'react', 'edit', 'del', 'rsvp', 'meta', 'role', 'pres', 'want', 'type']) {
    assert.equal(adminRequirement({ k }), null, `${k} must not require admin`);
  }
});

test('only the del half of a notice needs a resolved role', () => {
  // Any member may pin, so `add` must not be gated. `del` drops content and
  // is author-or-admin, so it needs an authoritative answer — and gets
  // `authorMayPass` so the blanket gate defers to that finer rule instead of
  // refusing every non-admin author.
  assert.equal(adminRequirement({ k: 'notice', op: 'add' }), null);
  assert.deepEqual(adminRequirement({ k: 'notice', op: 'del' }), {
    destructive: true,
    authorMayPass: true,
  });
});

test('an unknown kind needs no admin answer and changes nothing', () => {
  const r = circle();
  assert.equal(adminRequirement({ k: 'who-knows' }), null);
  const { effects } = apply(r, { k: 'who-knows', ch: 'x' });
  assert.deepEqual(effects, []);
  assert.deepEqual(r.channels, ['general']);
});

test('a gated kind is refused outright when the sender is not an admin', () => {
  for (const content of [
    { k: 'chan-del', ch: 'general' },
    { k: 'chan-ren', ch: 'general', to: 'renamed' },
    { k: 'chanset', ch: 'general', meta: { hid: 'h1' } },
    { k: 'vchan-del', ch: 'lounge' },
    { k: 'chan', ch: 'new' },
  ]) {
    const r = circle({ channels: ['general', 'other'] });
    const before = JSON.stringify(r);
    const { effects } = apply(r, content, { isAdmin: false });
    assert.deepEqual(effects, [], `${content.k} must produce no effects`);
    assert.equal(JSON.stringify(r), before, `${content.k} must not touch the record`);
  }
});

test('an unresolved admin answer fails closed', () => {
  // `null` means the caller never asked. Treating "unknown" as "allowed"
  // would make the whole gate bypassable by a bug in the caller.
  const r = circle({ channels: ['general', 'other'] });
  const { effects } = apply(r, { k: 'chan-del', ch: 'other' }, { isAdmin: null });
  assert.deepEqual(effects, []);
  assert.deepEqual(r.channels, ['general', 'other']);
});

/* ---------------------------------------------------------------- chat -- */

test('a chat line stores the message and clears the sender’s typing signal', () => {
  // A line landing is proof the sender stopped composing.
  const r = circle();
  const { effects } = apply(r, { k: 'chat', ch: 'general', text: 'hi', ts: 123 });
  assert.deepEqual(kinds(effects), ['clearTyping', 'storeMessage']);
  assert.deepEqual(find(effects, 'storeMessage').message, {
    server: 'srv',
    channel: 'general',
    sender: 'bob',
    text: 'hi',
    ts: 123,
  });
});

test('a chat line in an unknown channel creates it', () => {
  const r = circle();
  apply(r, { k: 'chat', ch: 'design', text: 'hi' });
  assert.deepEqual(r.channels, ['general', 'design']);
});

test('a chat line cannot resurrect a deleted channel', () => {
  // Otherwise a message still in flight when a channel was removed brings it
  // back on every device that receives it.
  const r = circle({ deletedChannels: ['design'] });
  apply(r, { k: 'chat', ch: 'design', text: 'hi' });
  assert.deepEqual(r.channels, ['general'], 'the tombstone holds');
});

test('a garbage timestamp falls back to this device’s clock', () => {
  const r = circle();
  const { effects } = apply(r, { k: 'chat', ch: 'general', text: 'hi', ts: 'soon' });
  assert.equal(find(effects, 'storeMessage').message.ts, NOW);
});

test('a reply quote is normalized and bounded, and omitted when unusable', () => {
  const r = circle();
  const long = 'x'.repeat(500);
  const { effects } = apply(r, {
    k: 'chat',
    ch: 'general',
    text: 'answer',
    reply: { sender: 'alice', ts: 5, text: long },
  });
  const { reply } = find(effects, 'storeMessage').message;
  assert.equal(reply.sender, 'alice');
  assert.ok(reply.text.length <= 140, 'the quote renders as text and is bounded');

  const r2 = circle();
  const { effects: e2 } = apply(r2, { k: 'chat', ch: 'general', text: 'a', reply: { sender: '' } });
  assert.equal('reply' in find(e2, 'storeMessage').message, false);
});

/* ------------------------------------------------------- edit / delete -- */

test('an edit is keyed to the authenticated sender, never the payload', () => {
  // The patch targets (sender, ts) where sender is the MLS-authenticated
  // one — so nobody can edit anyone else's line.
  const r = circle();
  const { effects } = apply(
    r,
    { k: 'edit', ch: 'general', to: { sender: 'alice', ts: 10 }, text: 'changed' },
    { sender: 'mallory' }
  );
  const patch = find(effects, 'editMessage');
  assert.equal(patch.sender, 'mallory', 'scoped to the sender, not to alice');
  assert.equal(patch.ts, 10);
  assert.deepEqual(kinds(effects), ['editMessage', 'refreshMessages']);
});

test('an edit with no text or no timestamp is ignored', () => {
  // An empty edit would otherwise blank a message.
  const r = circle();
  assert.deepEqual(apply(r, { k: 'edit', ch: 'general', to: { ts: 1 }, text: '' }).effects, []);
  assert.deepEqual(apply(r, { k: 'edit', ch: 'general', to: {}, text: 'x' }).effects, []);
});

test('a delete is scoped the same way and refreshes the pane', () => {
  const r = circle();
  const { effects } = apply(r, { k: 'del', ch: 'general', to: { ts: 7 } }, { sender: 'carol' });
  assert.deepEqual(kinds(effects), ['deleteMessage', 'refreshMessages']);
  assert.equal(find(effects, 'deleteMessage').sender, 'carol');
});

/* ----------------------------------------------------------- reactions -- */

test('a reaction carries the authenticated reactor, not the payload’s', () => {
  const r = circle();
  const { effects } = apply(
    r,
    { k: 'react', ch: 'general', emo: '🔥', to: { sender: 'alice', ts: 3 } },
    { sender: 'dave' }
  );
  const react = find(effects, 'reaction');
  assert.equal(react.by, 'dave');
  assert.deepEqual(react.target, { sender: 'alice', ts: 3 });
  assert.equal(react.op, 'add', 'anything but "del" is an add');
});

test('a malformed reaction is dropped', () => {
  const r = circle();
  for (const bad of [
    { k: 'react', emo: '', to: { sender: 'a', ts: 1 } },
    { k: 'react', emo: '🔥', to: { ts: 1 } },
    { k: 'react', emo: '🔥', to: { sender: 'a', ts: 'x' } },
  ]) {
    assert.deepEqual(apply(r, bad).effects, [], JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------- channels -- */

test('creating a channel clears its tombstone and announces it once', () => {
  const r = circle({ deletedChannels: ['design'] });
  const { effects } = apply(r, { k: 'chan', ch: 'design' });
  assert.deepEqual(r.channels, ['general', 'design']);
  assert.deepEqual(r.deletedChannels, [], 'a deliberate re-creation clears the tombstone');
  assert.deepEqual(kinds(effects), ['systemMessage', 'backup']);

  // A repeat is a no-op, so a rebroadcast does not spam the channel.
  assert.deepEqual(apply(r, { k: 'chan', ch: 'design' }).effects, []);
});

test('renaming a channel moves its messages before announcing it', () => {
  // Order matters: the system message lands in the new channel, so the rows
  // have to have moved first.
  const r = circle({ channels: ['general', 'design'], chanMeta: { design: { topic: 't' } } });
  const { effects } = apply(r, { k: 'chan-ren', ch: 'design', to: 'ui' });
  assert.deepEqual(r.channels, ['general', 'ui']);
  assert.deepEqual(r.chanMeta, { ui: { topic: 't' } }, 'settings follow the rename');
  assert.deepEqual(r.deletedChannels, ['design'], 'the old name becomes a tombstone');
  assert.deepEqual(kinds(effects), ['renameMessages', 'systemMessage', 'refreshMessages', 'backup']);
  assert.deepEqual(find(effects, 'renameMessages'), {
    t: 'renameMessages',
    server: 'srv',
    from: 'design',
    to: 'ui',
  });
});

test('renaming onto an existing channel is refused', () => {
  // It would silently merge two conversations.
  const r = circle({ channels: ['general', 'design'] });
  assert.deepEqual(apply(r, { k: 'chan-ren', ch: 'design', to: 'general' }).effects, []);
  assert.deepEqual(r.channels, ['general', 'design']);
});

test('the last channel cannot be deleted', () => {
  // A circle with no text channel has no usable UI.
  const r = circle({ channels: ['general'] });
  assert.deepEqual(apply(r, { k: 'chan-del', ch: 'general' }).effects, []);
  assert.deepEqual(r.channels, ['general']);
});

test('deleting a channel drops its settings and its stored messages', () => {
  const r = circle({ channels: ['general', 'design'], chanMeta: { design: { topic: 't' } } });
  const { effects } = apply(r, { k: 'chan-del', ch: 'design' });
  assert.deepEqual(r.channels, ['general']);
  assert.equal('design' in r.chanMeta, false);
  assert.deepEqual(r.deletedChannels, ['design']);
  assert.deepEqual(kinds(effects), ['deleteMessages', 'systemMessage', 'backup']);
});

test('tombstones are bounded so a record cannot grow without limit', () => {
  const r = circle();
  for (let i = 0; i < DELETED_MAX + 25; i += 1) markChannelDeleted(r, `ch${i}`);
  assert.equal(r.deletedChannels.length, DELETED_MAX);
  assert.equal(r.deletedChannels.at(-1), `ch${DELETED_MAX + 24}`, 'the newest are kept');
});

/* ---------------------------------------------------------- voice rooms -- */

test('deleting the room you are in forces you out of the call', () => {
  const r = circle({ voiceChannels: ['lounge', 'standup'] });
  const { effects } = apply(r, { k: 'vchan-del', ch: 'standup' }, {
    inCall: { server: 'srv', channel: 'standup' },
  });
  assert.deepEqual(r.voiceChannels, ['lounge']);
  assert.ok(kinds(effects).includes('leaveVoice'));
  assert.ok(
    kinds(effects).indexOf('leaveVoice') < kinds(effects).indexOf('systemMessage'),
    'leave before announcing, as the original did'
  );
});

test('deleting a room you are not in leaves your call alone', () => {
  const r = circle({ voiceChannels: ['lounge', 'standup'] });
  const { effects } = apply(r, { k: 'vchan-del', ch: 'standup' }, {
    inCall: { server: 'srv', channel: 'lounge' },
  });
  assert.equal(kinds(effects).includes('leaveVoice'), false);
});

test('a call in a different circle is never disturbed', () => {
  // `inCall` carries the server precisely so a same-named room elsewhere
  // cannot hang up your call.
  const r = circle({ voiceChannels: ['lounge', 'standup'] });
  const { effects } = apply(r, { k: 'vchan-del', ch: 'standup' }, {
    inCall: { server: 'other-circle', channel: 'standup' },
  });
  assert.equal(kinds(effects).includes('leaveVoice'), false);
});

/* --------------------------------------------------------------- chanset -- */

test('changing channel settings applies retention and re-reads history', () => {
  const r = circle();
  const { effects } = apply(r, { k: 'chanset', ch: 'general', meta: { hid: 'h1', retention: 3600 } });
  assert.deepEqual(r.chanMeta.general, { hid: 'h1', retention: 3600 });
  assert.deepEqual(kinds(effects), ['systemMessage', 'applyRetention', 'backfillHistory', 'backup']);
  assert.match(find(effects, 'systemMessage').text, /auto-delete: 1 hour/);
});

test('a chanset never drops a room key, whichever side minted it', () => {
  // Two members can mint a key for the same channel at once. Picking a
  // winner and dropping the loser would make the loser's messages
  // unreadable forever — they are the only copy there is.
  const r = circle({ chanMeta: { general: { hid: 'aaa', hkey: 'k-mine' } } });
  apply(r, { k: 'chanset', ch: 'general', meta: { hid: 'bbb', hkey: 'k-theirs' } });
  const meta = r.chanMeta.general;
  assert.equal(meta.hid, 'aaa', 'the lowest log id wins, identically on every device');
  assert.deepEqual(meta.alts, [{ hid: 'bbb', hkey: 'k-theirs' }], 'the other log is still read');
  assert.ok(
    [meta.hkey, ...(meta.hkeys ?? [])].includes('k-theirs'),
    'and its key is kept so its entries still open'
  );
});

test('a rotated key is archived rather than replaced', () => {
  const r = circle({ chanMeta: { general: { hid: 'h1', hkey: 'old' } } });
  apply(r, { k: 'chanset', ch: 'general', meta: { hid: 'h1', hkey: 'new' } });
  const meta = r.chanMeta.general;
  assert.ok([meta.hkey, ...(meta.hkeys ?? [])].includes('old'), 'entries before the rotation still open');
  assert.ok([meta.hkey, ...(meta.hkeys ?? [])].includes('new'));
});

test('chanset on an unknown channel creates it', () => {
  const r = circle();
  apply(r, { k: 'chanset', ch: 'design', meta: {} });
  assert.ok(r.channels.includes('design'));
});

/* ------------------------------------------------------------ metadata -- */

test('a meta rebroadcast only grows the shape', () => {
  // The union path must never remove a room this device knows about — that
  // is reserved for the authoritative sync below.
  const r = circle({ channels: ['general', 'private'], voiceChannels: ['lounge'] });
  apply(r, { k: 'meta', channels: ['general', 'design'], voiceChannels: ['lounge', 'standup'] });
  assert.deepEqual(r.channels, ['general', 'private', 'design']);
  assert.deepEqual(r.voiceChannels, ['lounge', 'standup']);
});

test('a meta rebroadcast cannot resurrect a deleted room', () => {
  // A peer that missed the deletion would otherwise bring it back on every
  // reconnect, since meta is rebroadcast per connect.
  const r = circle({ deletedChannels: ['design'], deletedVoice: ['standup'] });
  apply(r, { k: 'meta', channels: ['general', 'design'], voiceChannels: ['lounge', 'standup'] });
  assert.deepEqual(r.channels, ['general']);
  assert.deepEqual(r.voiceChannels, ['lounge']);
});

test('a pending sync adopts the snapshot wholesale, shrinking if it must', () => {
  // The one place the record is allowed to lose rooms: this device resumed
  // the log past the deletions and will never replay them.
  const r = circle({
    channels: ['general', 'phantom'],
    voiceChannels: ['lounge', 'ghost'],
    pendingMetaSync: true,
  });
  const { effects } = apply(r, { k: 'meta', channels: ['general'], voiceChannels: ['lounge'] });
  assert.deepEqual(r.channels, ['general'], 'phantom channel dropped');
  assert.deepEqual(r.voiceChannels, ['lounge']);
  assert.equal(r.pendingMetaSync, false, 'the sync happens once');
  assert.deepEqual(kinds(effects), ['backfillHistory', 'backup']);
});

test('a pending sync clears tombstones the snapshot contradicts', () => {
  // The snapshot is authoritative about what exists now, so a room it lists
  // is not a tombstone — otherwise it could never re-appear.
  const r = circle({ channels: ['general'], deletedChannels: ['design'], pendingMetaSync: true });
  apply(r, { k: 'meta', channels: ['general', 'design'] });
  assert.ok(r.channels.includes('design'));
  assert.deepEqual(r.deletedChannels, [], 'the contradicted tombstone is dropped');
});

test('existing channel settings are never clobbered by a rebroadcast', () => {
  // Explicit changes arrive as their own `chanset`; meta only gap-fills.
  const r = circle({ chanMeta: { general: { topic: 'mine' } } });
  apply(r, { k: 'meta', chanMeta: { general: { topic: 'theirs' }, design: { topic: 'new' } } });
  assert.equal(r.chanMeta.general.topic, 'mine', 'local wins');
  assert.equal(r.chanMeta.design.topic, 'new', 'the gap is filled');
});

test('an existing home base is not overwritten by a rebroadcast', () => {
  const r = circle({ overview: { blurb: 'ours' } });
  apply(r, { k: 'meta', overview: { blurb: 'theirs' } });
  assert.equal(r.overview.blurb, 'ours');
});

/* ---------------------------------------------------------------- rsvp -- */

test('an rsvp records and withdraws attendance', () => {
  const r = circle();
  apply(r, { k: 'rsvp', at: 999, going: true }, { sender: 'alice' });
  assert.deepEqual(r.rsvps.alice, { at: 999, ts: NOW });
  apply(r, { k: 'rsvp', at: 999, going: false }, { sender: 'alice' });
  assert.equal('alice' in r.rsvps, false);
});

test('an rsvp with no valid time is ignored', () => {
  const r = circle();
  apply(r, { k: 'rsvp', at: 'whenever', going: true }, { sender: 'alice' });
  assert.equal(r.rsvps, undefined);
});

/* ------------------------------------------------------------- notices -- */

test('the noticeboard author is the authenticated sender', () => {
  // Any member may pin, but nobody may pin *as* someone else.
  const r = circle();
  apply(r, { k: 'notice', op: 'add', n: { id: 'n1', text: 'standup at 10', author: 'alice' } }, {
    sender: 'carol',
  });
  assert.equal(r.notices?.[0]?.author, 'carol', 'the payload’s claimed author is ignored');
});

test('a known non-admin cannot unpin someone else’s notice', () => {
  const r = circle();
  apply(r, { k: 'notice', op: 'add', n: { id: 'n1', text: 'mine' } }, { sender: 'alice' });
  apply(r, { k: 'notice', op: 'del', id: 'n1' }, { sender: 'mallory', isAdmin: false });
  assert.equal(r.notices.length, 1, 'an established member is not an admin');
});

test('an author can unpin their own notice without being an admin', () => {
  // The reason `notice/del` carries `authorMayPass`: the blanket gate would
  // otherwise refuse this before the case body ever sees who the author is.
  const r = circle();
  apply(r, { k: 'notice', op: 'add', n: { id: 'n1', text: 'mine' } }, { sender: 'alice' });
  apply(r, { k: 'notice', op: 'del', id: 'n1' }, { sender: 'alice', isAdmin: false });
  assert.deepEqual(r.notices, []);
});

test('an admin can unpin someone else’s notice', () => {
  const r = circle();
  apply(r, { k: 'notice', op: 'add', n: { id: 'n1', text: 'mine' } }, { sender: 'alice' });
  apply(r, { k: 'notice', op: 'del', id: 'n1' }, { sender: 'root', isAdmin: true });
  assert.deepEqual(r.notices, []);
});

test('unpinning fails CLOSED when the remover’s role could not be resolved', () => {
  // This assertion used to say the opposite, and pinned a real defect.
  //
  // `canRemoveNotice` read the record's own roles map and returned true for
  // anyone absent from it. That map is populated only when something calls
  // `refreshRoles`, so it is empty on a restored record and stale for a
  // recent joiner — meaning the same `notice/del` was ACCEPTED on a device
  // with a cold roster and REFUSED on one with a warm roster. The board
  // desynchronised between members with no error anywhere, and a member
  // missing from a stale map could unpin anything.
  //
  // The role is now resolved by the caller against the relay's ACL before
  // the reducer runs, so `null` means "asked and could not establish it" —
  // which is refused, like every other destructive kind.
  const r = circle();
  apply(r, { k: 'notice', op: 'add', n: { id: 'n1', text: 'mine' } }, { sender: 'alice' });
  apply(r, { k: 'notice', op: 'del', id: 'n1' }, { sender: 'stranger', isAdmin: null });
  assert.equal(r.notices.length, 1, 'an unresolved role is refused, not waved through');
});

/* ---------------------------------------------------------------- role -- */

test('a role change announces itself and triggers a re-read of the ACL', () => {
  // Roles live in the relay's ACL; the envelope is only a nudge.
  const r = circle();
  const { effects } = apply(r, { k: 'role', user: 'alice', role: 'admin' });
  assert.deepEqual(kinds(effects), ['systemMessage', 'refreshRoles']);
  assert.match(find(effects, 'systemMessage').text, /alice is now an admin/);
});

/* ----------------------------------------------------------- ephemerals -- */

test('presence, rally and typing never touch the record', () => {
  // They live in reader-expired memory maps, and must never reach the
  // record store or the encrypted backup.
  const r = circle();
  const before = JSON.stringify(r);
  for (const k of ['pres', 'want', 'type']) {
    const { effects } = apply(r, { k, ch: 'general' });
    assert.equal(effects.length, 1, k);
    assert.equal(JSON.stringify(r), before, `${k} must leave the record untouched`);
  }
});
