// A channel's server-side log, folded into the messages a reader shows.
//
// The relay's log is append-only and the truth: a message, an edit of it, a
// deletion and a reaction are four entries, not one mutable row. Nothing
// here writes to disk — a channel log is rebuilt from the relay each
// session, which is what lets a fresh device (or a joiner) see the same
// conversation as everyone else.
//
// Folding is kept pure and separate from the I/O that fetches entries, for
// the same reason `envelope.js` is separate from the controller: the rules
// that decide "may this entry rewrite that line" are the security-relevant
// part, and they are reachable from a plain object in a test.
//
// Two properties the fold depends on, both from `history.js`:
//
//   1. Every entry carries its author's signature, so `entry.sender` is a
//      claim we can check rather than one we must take. Only entries whose
//      signature verified (`auth === 'signed'`) may mutate anything.
//   2. The signature covers the entry's location (circle + log id), so an
//      entry cannot be lifted from one channel into another.
//
// Order comes from the relay's `seq`, which is assigned at append time and
// total per log. Locally-originated entries (the copy you see the instant
// you press send, before the relay answers) get an ever-increasing local
// seq above every seen one, so they sort last until the real entry arrives
// and replaces them.

import { normalizeReply } from './envelope.js';
import { normalizeGameRef } from './games.js';

/** Kinds that create a message. */
const CONTENT_KINDS = new Set(['chat', 'file', 'game']);
/** Kinds that change one that already exists. */
const MUTATION_KINDS = new Set(['edit', 'del', 'react']);

const REACT_MAX = 8;

/** Identity of a message within a channel: its author and their timestamp.
    The same rule the live path has always used, so a log entry and the MLS
    message it copies collapse into one line rather than two. */
export const messageId = (sender, ts) => `${sender}:${ts}`;

/** Identity of a mutation, so the local echo and the relay's copy of the
    same edit/react are one event. */
const mutationId = (entry) => `${entry.sender}:${entry.k}:${entry.ts}`;

export function createChannelLog() {
  return {
    /** id -> message, exactly as written. Mutations are never applied in
        place: they are replayed over this on every render, so an edit that
        arrives before its target (paging backwards) still lands when the
        target shows up. */
    base: new Map(),
    /** mutationId -> {seq, entry} */
    mutations: new Map(),
    /** Lowest relay seq this device has fetched, and whether the fetch
        reached the start of the log. Drives "load older". */
    oldest: null,
    complete: false,
    /** Highest relay seq folded in, for the forward catch-up cursor. */
    newest: 0,
    /** Ordering counter for mutations this device originated, above any seq
        the relay will hand out, so a local echo sorts last until the real
        entry replaces it. */
    localSeq: Math.floor(Number.MAX_SAFE_INTEGER / 2),
  };
}

/**
 * Turn one decrypted entry into the message it describes, or null.
 *
 * Whitelists every field. An entry is written by whoever holds the room
 * key, so it must never be able to say where it lands (`server`,
 * `channel`), dress itself up as a system chip, or carry fields the
 * renderer would pass through untouched.
 */
export function entryToMessage(entry, { server, channel, auth, seq }) {
  const sender = String(entry.sender ?? '');
  const ts = Number(entry.ts) || 0;
  if (!sender || !ts) return null;
  const game = entry.game ? normalizeGameRef(entry.game) : null;
  const reply = normalizeReply(entry.reply);
  const body = entry.file
    ? { file: entry.file }
    : game
      ? { game }
      : { text: String(entry.text ?? '') };
  return {
    server,
    channel,
    sender,
    ts,
    ...body,
    ...(reply ? { reply } : {}),
    // How much the signature is worth. The renderer shows a sender as
    // authenticated only for 'signed'; see Messages.jsx.
    auth,
    seq,
  };
}

/**
 * Add decrypted entries to a channel log.
 *
 * @param log    from `createChannelLog`; mutated in place
 * @param items  `[{seq, entry, auth}]` — `auth` from `verifyEntries`
 * @returns how many entries were new to this log
 */
export function addEntries(log, items, { server, channel }) {
  let added = 0;
  for (const { seq, entry, auth, local = false } of items) {
    // A signature that did not verify is not a message with a caveat, it is
    // someone with the room key writing in another member's name. Drop it.
    if (!entry || auth === 'forged') continue;
    const kind = entry.k ?? 'chat'; // entries written before kinds existed
    if (Number.isFinite(seq)) {
      log.newest = Math.max(log.newest, seq);
      log.oldest = log.oldest === null ? seq : Math.min(log.oldest, seq);
    }

    if (CONTENT_KINDS.has(kind)) {
      const message = entryToMessage(entry, { server, channel, auth, seq });
      if (!message) continue;
      if (local) message.local = true;
      const id = messageId(message.sender, message.ts);
      const prior = log.base.get(id);
      // The relay's copy supersedes the local echo: it carries the real
      // seq and has been through the same signature check as everyone
      // else's. Never the other way round.
      if (prior && !(prior.local && !local)) continue;
      log.base.set(id, message);
      added += 1;
      continue;
    }

    if (MUTATION_KINDS.has(kind)) {
      // Only a verified author may rewrite or annotate a line. An unsigned
      // or unattributable mutation is exactly the shape a room-key holder
      // would forge to tamper with someone else's message, and unlike
      // content there is no legacy of them to stay compatible with.
      if (auth !== 'signed') continue;
      const id = mutationId(entry);
      if (log.mutations.has(id)) continue;
      log.mutations.set(id, { seq: Number.isFinite(seq) ? seq : log.localSeq++, entry });
      added += 1;
    }
  }
  return added;
}

/**
 * A device-local notice — "you joined", "#design was renamed", "bob was
 * removed" — placed in the channel's stream.
 *
 * These are deliberately NOT written to the relay's log. They are derived
 * from events this device watched happen, so every device would write its
 * own copy of the same line and readers would see the notice once per
 * member. They live for the session and are re-derived next time, which is
 * also why nothing here needs a signature: nobody else ever reads them.
 */
export function addSystemMessage(log, { server, channel, text, ts }) {
  const id = `sys:${ts}:${log.base.size}`;
  log.base.set(id, { server, channel, sender: '', text, ts, system: true });
  return id;
}

/** Record an entry this device just wrote or received live, before the
    relay's copy of it has been read back. It carries no relay seq — that is
    what marks it superseded when the real entry arrives, and what stops a
    redaction naming a sequence number the relay never issued. */
export function addLocalEntry(log, entry, { server, channel }) {
  return addEntries(log, [{ entry, auth: 'signed', local: true }], { server, channel });
}

function applyEdit(messages, entry) {
  const target = messages.get(messageId(entry.sender, Number(entry.to?.ts)));
  // Self-scoped: the signature proves who wrote the edit, and an edit only
  // applies to a line by that same author. Nobody can edit anyone else's.
  if (!target || target.deleted || target.file || target.game) return;
  const text = String(entry.text ?? '');
  if (!text) return;
  target.text = text;
  target.edited = true;
}

function applyDelete(messages, entry) {
  const id = messageId(entry.sender, Number(entry.to?.ts));
  const target = messages.get(id);
  if (!target) return;
  // A tombstone, not a hole: the line stays in place so a reply to it still
  // has something to point at. The body and its reactions go.
  messages.set(id, {
    server: target.server,
    channel: target.channel,
    sender: target.sender,
    ts: target.ts,
    seq: target.seq,
    auth: target.auth,
    deleted: true,
  });
}

function applyReaction(messages, entry) {
  const to = entry.to ?? {};
  const target = messages.get(messageId(String(to.sender ?? ''), Number(to.ts)));
  if (!target || target.deleted) return;
  const emo = String(entry.emo ?? '').slice(0, 8).trim();
  if (!emo) return;
  const reacts = { ...(target.reacts ?? {}) };
  const adding = entry.op !== 'del';
  // Bound how many distinct emoji one line can carry, so a member with the
  // room key cannot grow a message without limit.
  if (adding && reacts[emo] === undefined && Object.keys(reacts).length >= REACT_MAX) return;
  const set = new Set(reacts[emo] ?? []);
  // `entry.sender` is the signed author — a reaction can only ever be cast
  // in the name of whoever signed it.
  if (adding) set.add(entry.sender);
  else set.delete(entry.sender);
  if (set.size) reacts[emo] = [...set];
  else delete reacts[emo];
  target.reacts = reacts;
}

/**
 * The channel as it currently reads: content with every mutation replayed
 * over it in relay order, sorted by author timestamp.
 *
 * Recomputed rather than patched in place. The log is append-only and
 * arrives out of order (a page of old messages can land after an edit that
 * touches it), so replaying is the only way a reader converges on the same
 * answer regardless of what order the pages arrived in.
 */
export function renderLog(log) {
  const messages = new Map();
  for (const [id, m] of log.base) messages.set(id, { ...m });
  const ordered = [...log.mutations.values()].sort((a, b) => a.seq - b.seq);
  for (const { entry } of ordered) {
    if (entry.k === 'edit') applyEdit(messages, entry);
    else if (entry.k === 'del') applyDelete(messages, entry);
    else if (entry.k === 'react') applyReaction(messages, entry);
  }
  return [...messages.values()].sort((a, b) => a.ts - b.ts);
}

/** Drop everything older than `beforeTs` (auto-delete, applied at read
    time). Returns how many messages went. */
export function pruneLog(log, beforeTs) {
  let removed = 0;
  for (const [id, m] of log.base) {
    if (m.ts < beforeTs) {
      log.base.delete(id);
      removed += 1;
    }
  }
  for (const [id, { entry }] of log.mutations) {
    if (Number(entry.ts) < beforeTs) log.mutations.delete(id);
  }
  return removed;
}
