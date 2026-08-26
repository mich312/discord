// The protocol's semantic core: what an arriving envelope *means* for a
// circle's record, separated from the I/O that carries it out.
//
// This used to be a ~350-line switch inside `Controller.onContent`, where
// deciding "a channel was renamed" and performing "rename the rows in
// IndexedDB, write a system message, refresh the pane, reschedule the backup"
// were the same statement. Nothing about it could be exercised without a
// relay, a worker and a database — which is a poor place to keep the rules
// that decide who may delete a channel.
//
// `applyEnvelope` now returns the state change plus a list of *effect
// descriptors*; `Controller.runEffects` is the only thing that touches the
// world. Every case is reachable from a plain object in a test.
//
// Two deliberate limits, so this file does not claim more than it delivers:
//
//   1. It is **effect-free, not mutation-free.** The record is mutated in
//      place and handed back, because that is the contract every caller of
//      `onContent` already relies on (`db.serverPut(record)` afterwards).
//      Making the record immutable would double the size of this change for
//      no gain in testability, and testability is the point.
//
//   2. **Admin checks are resolved before the reducer runs**, not inside it.
//      `senderIsAdmin` is async — it can consult the relay's ACL — and an
//      async reducer is not a reducer. `adminRequirement` tells the caller
//      which kinds need the answer, so ordinary chat traffic does not pay for
//      a check it never uses.

import {
  canRemoveNotice,
  mergeNotices,
  normalizeNotice,
  normalizeOverview,
  reconcileMeta,
  upsertNotice,
} from './overview.js';
import { normalizeGameRef, normalizePresence, normalizeWant } from './games.js';
import {
  applyObjection,
  applySignature,
  canWithdraw,
  mergeProposals,
  normalizeProposal,
  normalizeProposals,
  normalizeThreshold,
  upsertProposal,
} from './quorum.js';
import {
  applyTake,
  canRemoveOffer,
  mergeOffers,
  normalizeOffer,
  normalizeOffers,
  upsertOffer,
} from './offers.js';

/* ------------------------------------------------------------ helpers -- */

/** A reply carries a *snapshot* of the answered line, not a pointer: E2EE
    gives a joiner no scrollback to resolve one against, so the quote must be
    self-contained. Bounded hard — it renders as text, never as markup. */
const REPLY_TEXT_MAX = 140;

export function normalizeReply(r) {
  if (!r || typeof r !== 'object') return null;
  const sender = String(r.sender ?? '').slice(0, 64).trim();
  const ts = Number(r.ts);
  if (!sender || !Number.isFinite(ts) || ts <= 0) return null;
  const text = String(r.text ?? '').slice(0, REPLY_TEXT_MAX);
  return { sender, ts, text };
}

/** Trust the sender's timestamp when it is sane, so every device orders and
    dedupes identically and it matches the kept-history copy. Older senders
    (or a hostile payload) may omit it or send garbage; a non-finite or
    non-positive value falls back to this device's own clock. */
export function messageTs(claimed, now = Date.now()) {
  const t = Number(claimed);
  return Number.isFinite(t) && t > 0 ? t : now;
}

/** A call's conversation thread lives under `voice:<room>` — real E2EE chat
    storage, but stage-scoped: it must never surface as a text room. */
export function isCallChat(channel) {
  return typeof channel === 'string' && channel.startsWith('voice:');
}

export function callChatChannel(room) {
  return `voice:${room}`;
}

export function describeRetention(seconds) {
  if (!seconds) return 'off';
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${seconds}s`;
}

/** Human-readable summary of a channel's settings for system messages. */
export function describeChanMeta(meta = {}) {
  const parts = [];
  // History is no longer a switch — every channel keeps one, because the
  // relay's log is where messages live. Retention is what varies, and it is
  // the setting worth announcing: it is what bounds how far back the room
  // key ever reaches.
  parts.push(meta.retention ? `auto-delete: ${describeRetention(meta.retention)}` : 'auto-delete: off');
  if (meta.topic) parts.push(`topic: “${meta.topic}”`);
  return ` (${parts.join(', ')})`;
}

/* -------------------------------------------------- record tombstones -- */

/** How many removed channel/room names a record remembers. Tombstones exist
    so a stray in-flight message cannot resurrect a deleted room; they are
    bounded so the record cannot grow without limit. */
export const DELETED_MAX = 200;

export function ensureChannel(record, ch) {
  if (isCallChat(ch) || record.channels.includes(ch)) return;
  if ((record.deletedChannels ?? []).includes(ch)) return;
  record.channels.push(ch);
}

/** Remember a removed channel so a stray message can't resurrect it. */
export function markChannelDeleted(record, ch) {
  record.deletedChannels = [...new Set([...(record.deletedChannels ?? []), ch])].slice(-DELETED_MAX);
}

/** A channel is legitimately (re-)created: it is no longer a tombstone. */
export function clearChannelDeleted(record, ch) {
  if (record.deletedChannels?.length) {
    record.deletedChannels = record.deletedChannels.filter((c) => c !== ch);
  }
}

export function markVoiceDeleted(record, ch) {
  record.deletedVoice = [...new Set([...(record.deletedVoice ?? []), ch])].slice(-DELETED_MAX);
}

export function clearVoiceDeleted(record, ch) {
  if (record.deletedVoice?.length) {
    record.deletedVoice = record.deletedVoice.filter((c) => c !== ch);
  }
}

/* ----------------------------------------------------- the admin gate -- */

/**
 * Does this envelope kind need the sender's admin status, and how strictly?
 *
 * `null` — no check. `{ destructive: false }` — advisory: fail *open* while
 * roles are still syncing, so a legitimate action racing role sync is not
 * dropped. `{ destructive: true }` — fail *closed*: these reach message
 * deletion, kept-history switches and auto-delete settings, where applying
 * one from a sender whose role cannot be established is a security
 * downgrade.
 *
 * `{ authorMayPass: true }` additionally means the blanket gate below must
 * not refuse outright — the sender's own content is theirs to remove, so the
 * case body applies the finer author-or-admin rule. The answer is still
 * resolved, because "not the author" has to fall back to something
 * authoritative.
 *
 * Takes the whole envelope rather than its kind: `notice` needs a role for
 * `op: 'del'` but not for `op: 'add'`, since any member may pin.
 *
 * Kept as data rather than scattered `if` statements because it is the
 * security-relevant part: a kind silently missing from this table is a kind
 * anyone can send.
 */
export function adminRequirement(content) {
  switch (content?.k) {
    case 'chan':
    case 'vchan':
    case 'overview':
      return { destructive: false };
    case 'chanset':
    case 'chan-ren':
    case 'chan-del':
    case 'vchan-ren':
    case 'vchan-del':
      return { destructive: true };
    // Unpinning drops content, so an unresolvable role fails closed like the
    // other destructive kinds rather than being waved through.
    case 'notice':
      return content.op === 'del' ? { destructive: true, authorMayPass: true } : null;
    // Same shape as a notice: anyone may post one or take a seat in one,
    // and taking a line down drops content, so it fails closed.
    case 'offer':
      return content.op === 'del' ? { destructive: true, authorMayPass: true } : null;
    // Any member may propose, sign or object — that is the whole point, and
    // gating it on a role would put membership back in an admin's hands.
    // Withdrawing drops content, so it fails closed like the rest.
    case 'quorum':
      return content.op === 'withdraw' ? { destructive: true, authorMayPass: true } : null;
    // The number it takes is the circle's constitution. An admin changes it,
    // and every member watches it change.
    case 'threshold':
      return { destructive: true };
    default:
      return null;
  }
}

/* ---------------------------------------------------------- the parse -- */

/**
 * Merge two views of one channel's settings without ever losing a key.
 *
 * Settings (topic, retention) have a clear owner: whoever sent the change.
 * Room keys do not, and they are not interchangeable with settings —
 * discarding one destroys every message it opens, which is now the only
 * copy of those messages.
 *
 * Two members can legitimately mint different keys for the same channel:
 * a channel with no key yet gets one from whoever next writes to it, and
 * two people writing at once both mint. So rather than pick a winner and
 * drop the loser, every (log id, key) pair either side knows is kept:
 *
 *   - `hid`/`hkey` — the log this device writes to. The winner is simply
 *     the lowest log id, which every device computes identically without
 *     talking to anyone, so a split converges by itself.
 *   - `alts`       — other logs that exist and still hold messages. Read,
 *     never written. Empty in the ordinary case.
 *   - `hkeys`      — every superseded key, for any of those logs. Reads try
 *     all of them, so a rotation or a race costs a decrypt attempt, not a
 *     stretch of the conversation.
 *
 * `mineWins` picks who owns the *settings* — false for an explicit
 * `chanset` (the sender is announcing a change), true for a metadata
 * rebroadcast (which only ever gap-fills).
 */
export function mergeChanKeys(mine = {}, theirs = {}, { mineWins = false } = {}) {
  const { hid: _mh, hkey: _mk, hkeys: _mks, alts: _ma, ...mySettings } = mine ?? {};
  const { hid: _th, hkey: _tk, hkeys: _tks, alts: _ta, ...theirSettings } = theirs ?? {};
  const settings = mineWins
    ? { ...theirSettings, ...mySettings }
    : { ...mySettings, ...theirSettings };

  // Every log either side knows about, and every key that has ever opened
  // it. A key with no log id is unusable, and vice versa.
  // A log id with no key yet is still the log this channel writes to, so it
  // is tracked with an empty key set rather than dropped.
  const logs = new Map();
  const note = (hid, keys) => {
    if (!hid) return;
    const set = logs.get(hid) ?? new Set();
    for (const k of keys) if (k) set.add(k);
    logs.set(hid, set);
  };
  for (const side of [mine, theirs]) {
    if (!side) continue;
    note(side.hid, [side.hkey, ...(side.hkeys ?? [])]);
    for (const alt of side.alts ?? []) note(alt?.hid, [alt?.hkey]);
    // A superseded key can outlive knowledge of which log it belonged to;
    // keep it against the side's own log rather than dropping it.
    note(side.hid, side.hkeys ?? []);
  }
  if (!logs.size) return settings;

  const hids = [...logs.keys()].sort();
  const primary = hids[0];
  // Prefer a current key someone is actually writing under.
  const preferred = [mine?.hid === primary && mine.hkey, theirs?.hid === primary && theirs.hkey]
    .filter(Boolean)
    .sort();
  const hkey = preferred[0] ?? [...logs.get(primary)][0];
  const hkeys = [...new Set([...logs.values()].flatMap((s) => [...s]))].filter(
    (k) => k && k !== hkey
  );
  const alts = hids
    .slice(1)
    .map((hid) => ({ hid, hkey: [...logs.get(hid)][0] }))
    .filter((a) => a.hkey);

  return {
    ...settings,
    hid: primary,
    ...(hkey ? { hkey } : {}),
    ...(hkeys.length ? { hkeys } : {}),
    ...(alts.length ? { alts } : {}),
  };
}

/**
 * Parse an envelope body. A payload that is not JSON is treated as a plain
 * chat line in `#general` — the oldest wire shape, and still what a
 * hand-rolled client would send.
 */
export function parseEnvelope(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { k: 'chat', ch: 'general', text: raw };
  }
}

/* -------------------------------------------------------- the reducer -- */

/**
 * Apply one authenticated envelope to a circle's record.
 *
 * @param record  the circle's stored record; mutated in place and returned
 * @param sender  the MLS-authenticated sender. Never taken from the payload.
 * @param content a parsed envelope (see `parseEnvelope`)
 * @param ctx     `{ isAdmin, now, inCall }`
 *                - `isAdmin`: the resolved answer for kinds that need one
 *                  (see `adminRequirement`); ignored otherwise.
 *                - `now`: clock, injected so message timestamps are testable.
 *                - `inCall`: `{ server, channel }` this device is currently
 *                  in, so a deleted room can force a leave without the
 *                  reducer reaching for the voice manager.
 * @returns `{ record, effects }`
 */
export function applyEnvelope(record, sender, content, ctx = {}) {
  const { isAdmin = null, now = Date.now(), inCall = null } = ctx;
  const effects = [];
  const emit = (effect) => effects.push(effect);
  const done = () => ({ record, effects });

  // The gate, applied once here rather than repeated per case. A kind that
  // needs an answer and did not get one is refused: `adminRequirement` is
  // the whole allowlist, so forgetting to resolve it fails closed.
  const need = adminRequirement(content);
  if (need && !need.authorMayPass && isAdmin !== true) return done();

  const inThisCall = (ch) => inCall?.server === record.id && inCall?.channel === ch;

  switch (content.k) {
    case 'chat': {
      ensureChannel(record, content.ch);
      // A line landing is proof the sender stopped composing — clear their
      // typing signal now instead of waiting for it to age out.
      emit({ t: 'clearTyping', server: record.id, sender });
      const reply = normalizeReply(content.reply);
      emit({
        t: 'storeMessage',
        message: {
          server: record.id,
          channel: content.ch,
          sender,
          text: content.text,
          ts: messageTs(content.ts, now),
          ...(reply ? { reply } : {}),
        },
      });
      break;
    }

    case 'game': {
      // Same channel handling as chat; the ref is whitelisted and the Join
      // affordance resolves against the shelf, never this payload.
      const game = normalizeGameRef(content.game);
      if (!game) break;
      ensureChannel(record, content.ch);
      emit({
        t: 'storeMessage',
        message: { server: record.id, channel: content.ch, sender, game, ts: messageTs(content.ts, now) },
      });
      break;
    }

    case 'file': {
      ensureChannel(record, content.ch);
      emit({
        t: 'storeMessage',
        message: {
          server: record.id,
          channel: content.ch,
          sender,
          file: content.file,
          ts: messageTs(content.ts, now),
        },
      });
      break;
    }

    // Ephemeral by design: these live in controller-side maps, expired by
    // readers, never written to the record store or the backup.
    case 'pres':
      emit({ t: 'presence', server: record.id, sender, value: normalizePresence(content) });
      break;
    case 'want':
      emit({ t: 'want', server: record.id, sender, value: normalizeWant(content) });
      break;
    case 'type':
      emit({ t: 'typing', server: record.id, sender, channel: content.ch });
      break;

    case 'react': {
      const emo = String(content.emo ?? '').slice(0, 8).trim();
      const to = content.to ?? {};
      const op = content.op === 'del' ? 'del' : 'add';
      if (!emo || !to.sender || !Number.isFinite(Number(to.ts))) break;
      emit({
        t: 'reaction',
        server: record.id,
        channel: String(content.ch ?? ''),
        target: { sender: String(to.sender), ts: Number(to.ts) },
        emo,
        op,
        by: sender,
        // The mutation's own timestamp, not its target's. It is what makes
        // this the same event as the log entry the sender also wrote —
        // (sender, kind, ts) — so the two collapse instead of applying
        // twice, and it is what orders two edits of the same line.
        at: messageTs(content.ts, now),
      });
      emit({ t: 'refreshMessages' });
      break;
    }

    case 'edit': {
      const ts = Number(content.to?.ts);
      const text = String(content.text ?? '');
      if (!Number.isFinite(ts) || !text) break;
      // Keyed on (sender, ts): the edit lands only on a line with this
      // authenticated sender and ts, so no one can edit anyone else's
      // message and a reader without the line simply no-ops.
      emit({
        t: 'editMessage',
        server: record.id,
        channel: String(content.ch ?? ''),
        sender,
        ts,
        text,
        at: messageTs(content.ts, now),
      });
      emit({ t: 'refreshMessages' });
      break;
    }

    case 'del': {
      const ts = Number(content.to?.ts);
      if (!Number.isFinite(ts)) break;
      // Same (sender, ts) self-scoping as edit. A tombstone: readers fold it
      // over the original. Removing the original from the relay's log is a
      // separate, authorized request the sender makes — see
      // `Controller.deleteMessage` — and neither can reach a device that
      // already fetched the line.
      emit({
        t: 'deleteMessage',
        server: record.id,
        channel: String(content.ch ?? ''),
        sender,
        ts,
        at: messageTs(content.ts, now),
      });
      emit({ t: 'refreshMessages' });
      break;
    }

    case 'rsvp': {
      const at = Number(content.at);
      if (!Number.isFinite(at)) break;
      const rsvps = { ...(record.rsvps ?? {}) };
      if (content.going) rsvps[sender] = { at, ts: now };
      else delete rsvps[sender];
      record.rsvps = rsvps;
      break;
    }

    case 'meta':
      applyMeta(record, content, emit);
      break;

    case 'chanset': {
      // A channel's settings changed: topic or auto-delete. The room key
      // rides in `meta.hkey` — inside MLS, so the relay never sees it. The
      // sender's copy is authoritative for the settings, but never for the
      // keys: see `mergeChanKeys`.
      if (!record.channels.includes(content.ch)) record.channels.push(content.ch);
      const incoming = content.meta ?? {};
      record.chanMeta = {
        ...(record.chanMeta ?? {}),
        [content.ch]: mergeChanKeys(record.chanMeta?.[content.ch], incoming),
      };
      emit({
        t: 'systemMessage',
        server: record.id,
        text: `#${content.ch} settings changed by ${sender}${describeChanMeta(content.meta)}`,
        channel: content.ch,
      });
      emit({ t: 'applyRetention', channel: content.ch });
      emit({ t: 'backfillHistory' });
      emit({ t: 'backup' });
      break;
    }

    case 'overview': {
      record.overview = normalizeOverview(content.ov);
      emit({ t: 'systemMessage', server: record.id, text: `home base updated by ${sender}` });
      emit({ t: 'backup' });
      break;
    }

    case 'notice': {
      // The noticeboard is the whole roster's — any member may pin. The
      // author is the MLS-authenticated sender, never the payload.
      if (content.op === 'add') {
        const notice = normalizeNotice(content.n, sender);
        if (notice) {
          record.notices = upsertNotice(record.notices, notice);
          emit({ t: 'backup' });
        }
      } else if (content.op === 'del') {
        const target = (record.notices ?? []).find((n) => n.id === content.id);
        // `isAdmin`, not `record.roles`: the caller resolved it against the
        // relay's ACL, so every device answers this identically instead of
        // from whatever its own roster happened to hold.
        if (target && canRemoveNotice(target, sender, isAdmin === true)) {
          record.notices = record.notices.filter((n) => n.id !== content.id);
          emit({ t: 'backup' });
        }
      }
      break;
    }

    case 'offer': {
      // The board belongs to the whole roster, like the noticeboard: any
      // member may post a lift or take a seat in one. The author is the
      // MLS-authenticated sender, never the payload.
      if (content.op === 'add') {
        const offer = normalizeOffer(content.o, sender);
        if (offer) {
          record.offers = upsertOffer(record.offers, offer);
          emit({ t: 'backup' });
        }
      } else if (content.op === 'take') {
        // `sender`, not a name in the payload: you may only take a seat as
        // yourself. applyTake refuses to overfill, so the last seat going to
        // two people at once resolves the same way on every device — log
        // order decides and the loser sees a full car.
        record.offers = applyTake(record.offers, content.id, sender, content.taking !== false);
        emit({ t: 'backup' });
      } else if (content.op === 'del') {
        const target = (record.offers ?? []).find((o) => o.id === content.id);
        if (target && canRemoveOffer(target, sender, isAdmin === true)) {
          record.offers = record.offers.filter((o) => o.id !== content.id);
          emit({ t: 'backup' });
        }
      }
      break;
    }

    case 'quorum': {
      // The signer is the sender, always. A ledger a member can write other
      // people's names into is not a ledger.
      if (content.op === 'propose') {
        const proposal = normalizeProposal(content.p, sender);
        if (proposal) {
          record.proposals = upsertProposal(record.proposals, proposal);
          emit({ t: 'quorumCheck', id: proposal.id });
          emit({ t: 'backup' });
        }
      } else if (content.op === 'sign') {
        record.proposals = applySignature(record.proposals, content.id, sender);
        emit({ t: 'quorumCheck', id: content.id });
        emit({ t: 'backup' });
      } else if (content.op === 'object') {
        record.proposals = applyObjection(record.proposals, content.id, sender, content.why);
        emit({ t: 'backup' });
      } else if (content.op === 'withdraw') {
        const target = (record.proposals ?? []).find((p) => p.id === content.id);
        if (target && canWithdraw(target, sender, isAdmin === true)) {
          record.proposals = record.proposals.filter((p) => p.id !== content.id);
          emit({ t: 'backup' });
        }
      }
      break;
    }

    case 'threshold': {
      record.threshold = normalizeThreshold(content.n, (record.members ?? []).length);
      emit({
        t: 'systemMessage',
        server: record.id,
        text: `${sender} set the signatures a new member needs to ${record.threshold}`,
      });
      emit({ t: 'backup' });
      break;
    }

    case 'chan': {
      clearChannelDeleted(record, content.ch);
      if (!record.channels.includes(content.ch)) {
        record.channels.push(content.ch);
        emit({
          t: 'systemMessage',
          server: record.id,
          text: `#${content.ch} created by ${sender}`,
          channel: content.ch,
        });
        emit({ t: 'backup' });
      }
      break;
    }

    case 'vchan': {
      clearVoiceDeleted(record, content.ch);
      const rooms = record.voiceChannels ?? ['lounge'];
      if (!rooms.includes(content.ch)) {
        record.voiceChannels = [...rooms, content.ch];
        emit({
          t: 'systemMessage',
          server: record.id,
          text: `voice room "${content.ch}" created by ${sender}`,
        });
      }
      break;
    }

    case 'chan-ren': {
      if (record.channels.includes(content.ch) && !record.channels.includes(content.to)) {
        record.channels = record.channels.map((c) => (c === content.ch ? content.to : c));
        markChannelDeleted(record, content.ch);
        clearChannelDeleted(record, content.to);
        if (record.chanMeta?.[content.ch]) {
          record.chanMeta = { ...record.chanMeta, [content.to]: record.chanMeta[content.ch] };
          delete record.chanMeta[content.ch];
        }
        emit({ t: 'renameMessages', server: record.id, from: content.ch, to: content.to });
        emit({
          t: 'systemMessage',
          server: record.id,
          text: `#${content.ch} renamed to #${content.to}`,
          channel: content.to,
        });
        emit({ t: 'refreshMessages' });
        emit({ t: 'backup' });
      }
      break;
    }

    case 'chan-del': {
      // A circle must always keep at least one text channel.
      if (record.channels.includes(content.ch) && record.channels.length > 1) {
        record.channels = record.channels.filter((c) => c !== content.ch);
        markChannelDeleted(record, content.ch);
        if (record.chanMeta?.[content.ch]) {
          record.chanMeta = { ...record.chanMeta };
          delete record.chanMeta[content.ch];
        }
        emit({ t: 'deleteMessages', server: record.id, channel: content.ch });
        emit({ t: 'systemMessage', server: record.id, text: `#${content.ch} deleted by ${sender}` });
        emit({ t: 'backup' });
      }
      break;
    }

    case 'vchan-ren': {
      const rooms = record.voiceChannels ?? ['lounge'];
      if (rooms.includes(content.ch) && !rooms.includes(content.to)) {
        record.voiceChannels = rooms.map((c) => (c === content.ch ? content.to : c));
        markVoiceDeleted(record, content.ch);
        clearVoiceDeleted(record, content.to);
        if (inThisCall(content.ch)) emit({ t: 'leaveVoice' });
        emit({
          t: 'systemMessage',
          server: record.id,
          text: `voice room "${content.ch}" renamed to "${content.to}"`,
        });
        emit({ t: 'backup' });
      }
      break;
    }

    case 'vchan-del': {
      const rooms = record.voiceChannels ?? ['lounge'];
      if (rooms.includes(content.ch)) {
        record.voiceChannels = rooms.filter((c) => c !== content.ch);
        markVoiceDeleted(record, content.ch);
        if (inThisCall(content.ch)) emit({ t: 'leaveVoice' });
        emit({
          t: 'systemMessage',
          server: record.id,
          text: `voice room "${content.ch}" deleted by ${sender}`,
        });
        emit({ t: 'backup' });
      }
      break;
    }

    case 'role': {
      // Roles live in the relay's ACL; this envelope just tells everyone to
      // re-read them and leaves a trace in the channel.
      emit({
        t: 'systemMessage',
        server: record.id,
        text: `${content.user} is now ${content.role === 'admin' ? 'an admin' : 'a regular member'} (changed by ${sender})`,
      });
      emit({ t: 'refreshRoles', server: record.id });
      break;
    }
  }

  return done();
}

/**
 * The `meta` rebroadcast: a peer's full snapshot of the circle's shape.
 *
 * Split out because it is a third of the switch on its own, and because it
 * is the only place the record is allowed to *shrink*.
 */
function applyMeta(record, content, emit) {
  record.name = content.name ?? record.name;

  // A device catching up after a (re-)join or restore may be holding a stale
  // shape: phantom channels a since-departed admin deleted, a game hub from
  // before the shelf changed, notices long since unpinned. It resumed the log
  // past those events and will never replay them, but the rebroadcaster has
  // and is authoritative — so adopt its snapshot wholesale. The union path
  // below can only ever grow the shape; this is the one place it must be
  // allowed to shrink.
  if (record.pendingMetaSync) {
    record.pendingMetaSync = false;
    Object.assign(record, reconcileMeta(content));
    // The snapshot is authoritative about what exists now, so a channel or
    // voice room it lists is not a tombstone — drop any stale one so it isn't
    // wrongly blocked from re-appearing.
    if (record.deletedChannels?.length) {
      record.deletedChannels = record.deletedChannels.filter((c) => !record.channels.includes(c));
    }
    if (record.deletedVoice?.length) {
      record.deletedVoice = record.deletedVoice.filter(
        (c) => !(record.voiceChannels ?? []).includes(c)
      );
    }
    emit({ t: 'backfillHistory' });
    emit({ t: 'backup' });
    return;
  }

  // Union gap-fill: adopt rooms this device is missing, but never a room it
  // has seen deleted — otherwise a peer that missed the deletion would
  // resurrect it on every meta rebroadcast (now one per connect).
  for (const ch of content.channels ?? []) {
    if (!record.channels.includes(ch) && !(record.deletedChannels ?? []).includes(ch)) {
      record.channels.push(ch);
    }
  }
  if (content.voiceChannels) {
    const rooms = record.voiceChannels ?? ['lounge'];
    for (const ch of content.voiceChannels) {
      if (!rooms.includes(ch) && !(record.deletedVoice ?? []).includes(ch)) rooms.push(ch);
    }
    record.voiceChannels = rooms;
  }

  // Gap-fill the home base the same way: a joiner has none, and explicit
  // edits arrive as their own `overview`/`notice` events. Adopting it
  // re-parks the backup so it survives a vault restore.
  if (content.overview !== undefined && record.overview == null) {
    const adopted = normalizeOverview(content.overview);
    if (adopted) {
      record.overview = adopted;
      emit({ t: 'backup' });
    }
  }

  // Noticeboard union: ids this device already has win. Authors in a
  // rebroadcast are vouched for by the rebroadcaster, like the rest of the
  // metadata a joiner has no scrollback to verify.
  if (Array.isArray(content.notices) && content.notices.length) {
    const incoming = content.notices.map((n) => normalizeNotice(n, n?.author)).filter(Boolean);
    const merged = mergeNotices(record.notices, incoming);
    if (merged.length !== (record.notices ?? []).length) {
      record.notices = merged;
      emit({ t: 'backup' });
    }
  }

  // Lifts and kit, union the same way, ids this device already has winning —
  // so a claim it has already seen is not undone by a rebroadcast that
  // predates it.
  if (Array.isArray(content.offers) && content.offers.length) {
    const merged = mergeOffers(record.offers, normalizeOffers(content.offers));
    if (merged.length !== (record.offers ?? []).length) {
      record.offers = merged;
      emit({ t: 'backup' });
    }
  }

  // The ledger, union the same way. A joiner needs to see what is already in
  // front of the circle, including the proposal that let them in.
  if (Array.isArray(content.proposals) && content.proposals.length) {
    const merged = mergeProposals(record.proposals, normalizeProposals(content.proposals));
    if (merged.length !== (record.proposals ?? []).length) {
      record.proposals = merged;
      emit({ t: 'backup' });
    }
  }
  if (content.threshold !== undefined && record.threshold === undefined) {
    record.threshold = normalizeThreshold(content.threshold, (record.members ?? []).length);
    emit({ t: 'backup' });
  }

  // Gap-fill RSVPs the same way (a joiner has none). Bounded and
  // whitelisted: handle -> {at}. Existing local answers win.
  if (content.rsvps && typeof content.rsvps === 'object') {
    const mine = record.rsvps ?? {};
    const merged = { ...mine };
    for (const [handle, v] of Object.entries(content.rsvps).slice(0, 64)) {
      const at = Number(v?.at);
      if (!Number.isFinite(at) || merged[handle]) continue;
      merged[String(handle).slice(0, 64)] = { at, ts: Number(v?.ts) || Date.now() };
    }
    record.rsvps = merged;
  }

  // Gap-fill channel settings (a joiner has none): explicit changes arrive as
  // their own `chanset` events, so this never clobbers a setting. Keys are
  // the exception and are merged rather than picked between — see
  // `mergeChanKeys`.
  if (content.chanMeta) {
    const mine = record.chanMeta ?? {};
    for (const [ch, meta] of Object.entries(content.chanMeta)) {
      mine[ch] = mergeChanKeys(mine[ch], meta, { mineWins: true });
    }
    record.chanMeta = mine;
    emit({ t: 'backfillHistory' });
  }
}
