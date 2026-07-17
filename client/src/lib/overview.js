// The circle's home base: the pure rules for its landing-page data.
// Everything here crosses devices inside MLS envelopes, so it is all
// normalized on receive — whitelisted fields, bounded sizes — a hostile
// envelope must not smuggle structure or megabytes into every member's
// record (and encrypted backup). No I/O in this module; the controller
// owns sending/receiving, this owns the shapes and the merge rules.

export const BLURB_MAX = 4000;
export const LINKS_MAX = 12;
export const NOTICE_MAX = 500;
export const NOTICES_MAX = 30;

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;

/** The admin-edited half of the page: blurb, pinned links, and the next
    team event. Returns null when there is nothing to keep. */
export function normalizeOverview(ov) {
  if (!ov || typeof ov !== 'object') return null;
  const blurb = typeof ov.blurb === 'string' ? ov.blurb.slice(0, BLURB_MAX).trim() : '';
  const links = (Array.isArray(ov.links) ? ov.links : [])
    .slice(0, LINKS_MAX)
    .map((l) => ({
      label: String(l?.label ?? '').slice(0, 120).trim(),
      url: String(l?.url ?? '').slice(0, 2048).trim(),
    }))
    .filter((l) => l.url);
  const event = normalizeEvent(ov.event);
  if (!blurb && links.length === 0 && !event) return null;
  return { blurb, links, ...(event ? { event } : {}) };
}

function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const title = String(ev.title ?? '').slice(0, 120).trim();
  const at = Number(ev.at);
  const note = String(ev.note ?? '').slice(0, 280).trim();
  if (!title || !Number.isFinite(at) || at <= 0) return null;
  return { title, at, ...(note ? { note } : {}) };
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
