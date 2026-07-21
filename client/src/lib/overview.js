// The circle's home base: the pure rules for its landing-page data.
// Everything here crosses devices inside MLS envelopes, so it is all
// normalized on receive — whitelisted fields, bounded sizes — a hostile
// envelope must not smuggle structure or megabytes into every member's
// record (and encrypted backup). No I/O in this module; the controller
// owns sending/receiving, this owns the shapes and the merge rules.

import { normalizeGames } from './games.js';

export const BLURB_MAX = 4000;
export const LINKS_MAX = 12;
export const NOTICE_MAX = 500;
export const NOTICES_MAX = 30;
export const EVENTS_MAX = 12;

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;
// A just-passed event still counts as "up next" for this long, so the mirror
// old clients read (and the soonest picker) don't drop an event mid-session.
const EVENT_GRACE = 6 * HOUR;

/** The admin-edited half of the page: blurb, pinned links, the shelf, and
    now a schedule of events — each optionally tied to a game (a "game
    night"). Returns null when there is nothing to keep.

    Migration: earlier builds carried a single `event`. We read either shape
    (an `events` array, or a legacy `event`) and always write BOTH — the
    array plus a legacy `event` mirror of the soonest one — so a client that
    only understands the old field still shows something from the same
    payload. `now` only picks that mirror; it never changes what's stored. */
export function normalizeOverview(ov, now = Date.now()) {
  if (!ov || typeof ov !== 'object') return null;
  const blurb = typeof ov.blurb === 'string' ? ov.blurb.slice(0, BLURB_MAX).trim() : '';
  const links = (Array.isArray(ov.links) ? ov.links : [])
    .slice(0, LINKS_MAX)
    .map((l) => ({
      label: String(l?.label ?? '').slice(0, 120).trim(),
      url: String(l?.url ?? '').slice(0, 2048).trim(),
    }))
    .filter((l) => l.url);
  const events = normalizeEvents(ov.events ?? (ov.event ? [ov.event] : []));
  const games = normalizeGames(ov.games);
  if (!blurb && links.length === 0 && events.length === 0 && games.length === 0) return null;
  const mirror = legacyEventMirror(events, now);
  return {
    blurb,
    links,
    ...(events.length ? { events } : {}),
    ...(mirror ? { event: mirror } : {}),
    ...(games.length ? { games } : {}),
  };
}

/** One scheduled event. `gameId` (optional) ties it to a shelf game so the
    hub can surface it as a game night; the reader resolves the id against
    its own registry, so a dangling id simply shows no game. `id` is stable
    (derived from the timestamp when absent) for keys and de-duplication. */
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const title = String(ev.title ?? '').slice(0, 120).trim();
  const at = Number(ev.at);
  const note = String(ev.note ?? '').slice(0, 280).trim();
  if (!title || !Number.isFinite(at) || at <= 0) return null;
  const id = String(ev.id ?? '').slice(0, 40).trim() || `e${Math.round(at).toString(36)}`;
  const gameId = String(ev.gameId ?? '').slice(0, 40).trim();
  return { id, title, at, ...(note ? { note } : {}), ...(gameId ? { gameId } : {}) };
}

/** A bounded, de-duplicated, soonest-first schedule. */
export function normalizeEvents(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    const ev = normalizeEvent(e);
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
    if (out.length >= EVENTS_MAX) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The single event an old client should see: the soonest still-upcoming
    one (with grace), else the most recent past one. Stripped to the legacy
    shape — title/at/note only. */
function legacyEventMirror(events, now) {
  if (!events.length) return null;
  const upcoming = events.filter((e) => e.at >= now - EVENT_GRACE);
  const pick = upcoming.length ? upcoming[0] : events[events.length - 1];
  return { title: pick.title, at: pick.at, ...(pick.note ? { note: pick.note } : {}) };
}

/** A noticeboard entry as received. The author is never taken from the
    payload — it is the (MLS-authenticated) sender, passed by the caller. */
export function normalizeNotice(n, author, now = Date.now()) {
  if (!n || typeof n !== 'object') return null;
  const id = String(n.id ?? '').slice(0, 40);
  const text = String(n.text ?? '').slice(0, NOTICE_MAX).trim();
  let ts = Number(n.ts);
  // A claimed timestamp orders the board; clamp nonsense to "now" so a
  // far-future ts can't pin an entry to the top forever.
  if (!Number.isFinite(ts) || ts <= 0 || ts > now + MIN) ts = now;
  if (!id || !text) return null;
  return { id, text, ts, author: String(author ?? '') };
}

/** Insert-or-replace one notice; newest first, capped. */
export function upsertNotice(list, notice) {
  if (!notice) return list ?? [];
  return [notice, ...(list ?? []).filter((n) => n.id !== notice.id)]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, NOTICES_MAX);
}

/** Authoritative reconcile of a circle's synced shape from a meta
    rebroadcast, for a device that just (re-)joined or was restored and so
    resumed the log past the changes it missed. Unlike the live gap-fill
    (union, which can only grow), this adopts the rebroadcaster's snapshot
    wholesale so deletions — phantom channels, an unpinned notice, a cleared
    game hub — actually land. Returns only the fields present in the snapshot,
    normalized and bounded, for the caller to assign onto the record. */
export function reconcileMeta(content) {
  const out = {};
  if (Array.isArray(content.channels) && content.channels.length) {
    out.channels = [...new Set(content.channels)];
  }
  if (Array.isArray(content.voiceChannels) && content.voiceChannels.length) {
    out.voiceChannels = [...new Set(content.voiceChannels)];
  }
  if (content.overview !== undefined) {
    out.overview = normalizeOverview(content.overview);
  }
  if (content.chanMeta && typeof content.chanMeta === 'object') {
    out.chanMeta = { ...content.chanMeta };
  }
  if (Array.isArray(content.notices)) {
    out.notices = content.notices
      .map((n) => normalizeNotice(n, n?.author))
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, NOTICES_MAX);
  }
  if (content.rsvps && typeof content.rsvps === 'object') {
    const rsvps = {};
    for (const [handle, v] of Object.entries(content.rsvps).slice(0, 64)) {
      const at = Number(v?.at);
      if (!Number.isFinite(at)) continue;
      rsvps[String(handle).slice(0, 64)] = { at, ts: Number(v?.ts) || Date.now() };
    }
    out.rsvps = rsvps;
  }
  return out;
}

/** Union for the joiner gap-fill (meta rebroadcast): entries this device
    already has win over the incoming copy of the same id. */
export function mergeNotices(mine, incoming) {
  const have = new Set((mine ?? []).map((n) => n.id));
  const merged = [...(mine ?? []), ...(incoming ?? []).filter((n) => n && !have.has(n.id))];
  return merged.sort((a, b) => b.ts - a.ts).slice(0, NOTICES_MAX);
}

/** May `requester` remove this notice? Authors always may; admins may.
    Same advisory model as every role gate here: fail open while the
    requester's role is still unknown, the roster's eyes do the rest. */
export function canRemoveNotice(notice, requester, roles) {
  if (!notice) return false;
  if (requester === notice.author) return true;
  if (roles?.[requester]) return roles[requester] === 'admin';
  return true;
}

/** Countdown label for the up-next block: "in 3 days", "in 5 h",
    "in 12 min", "now" while it is on (6 h grace), then it ages out
    like any past timestamp. */
export function describeUntil(at, now = Date.now()) {
  const d = at - now;
  if (d <= 0) return d > -6 * HOUR ? 'now' : describeAgo(at, now);
  if (d < MIN) return 'in under a minute';
  if (d < 2 * HOUR) return `in ${Math.round(d / MIN)} min`;
  if (d < 2 * DAY) return `in ${Math.round(d / HOUR)} h`;
  return `in ${Math.round(d / DAY)} days`;
}

/** Relative past label for previews and notices. */
export function describeAgo(ts, now = Date.now()) {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'just now';
  if (d < 2 * HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < 2 * DAY) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / DAY)} days ago`;
}
