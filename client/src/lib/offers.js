// The board module that makes a race team's board look like a race team's.
//
// A circle keeps offering each other things that are not messages and not
// events: a seat in a car to the start, a spare wheel, where to pick the
// numbers up. The design calls the block "lifts & kit"; the photo club's
// version is the print swap. Underneath they are one shape — a short line,
// posted by a member, sometimes with a limited number of takers.
//
// So this is the noticeboard with a count on it, and it is deliberately not
// more than that. The alternative was a per-circle module type with its own
// schema, and a schema per circle is how a product ends up with a "circle
// type" nobody wanted to choose.
//
// Everything here is pure, and everything crosses devices inside MLS
// envelopes, so it is all normalized on receive with whitelisted fields and
// bounded sizes — a hostile envelope must not smuggle structure or megabytes
// into every member's record and backup.

export const OFFER_MAX = 200;
export const OFFERS_MAX = 24;
/** Seats one line may offer. Above this it is a rota, not a lift. */
export const SEATS_MAX = 32;

const MIN = 60e3;

/**
 * One offer as received. The author is never taken from the payload — it is
 * the (MLS-authenticated) sender, passed by the caller, exactly as a notice's
 * is. `takers` is not on the wire either: claims arrive as their own
 * envelopes so that two people taking the last seat is a race the log
 * resolves, rather than two clients overwriting each other's list.
 */
export function normalizeOffer(o, author, now = Date.now()) {
  if (!o || typeof o !== 'object') return null;
  const id = String(o.id ?? '').slice(0, 40);
  const text = String(o.text ?? '').slice(0, OFFER_MAX).trim();
  const note = String(o.note ?? '').slice(0, OFFER_MAX).trim();
  // 0 means "this is a fact, not a thing to claim" — the spare wheels in
  // dana's car, the numbers pickup at half seven.
  let seats = Number(o.seats);
  if (!Number.isFinite(seats) || seats < 0) seats = 0;
  seats = Math.min(SEATS_MAX, Math.floor(seats));
  let ts = Number(o.ts);
  if (!Number.isFinite(ts) || ts <= 0 || ts > now + MIN) ts = now;
  if (!id || !text) return null;
  return { id, text, ...(note ? { note } : {}), seats, ts, author: String(author ?? ''), takers: [] };
}

/** Insert-or-replace one offer, newest first, capped. An edit keeps whoever
    had already taken a seat: the line changed, not the promise. */
export function upsertOffer(list, offer) {
  if (!offer) return list ?? [];
  const prior = (list ?? []).find((o) => o.id === offer.id);
  const kept = prior ? { ...offer, takers: prior.takers ?? [] } : offer;
  return [kept, ...(list ?? []).filter((o) => o.id !== offer.id)]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, OFFERS_MAX);
}

/** How many seats are left, or null when the line is not claimable. */
export function seatsLeft(offer) {
  if (!offer?.seats) return null;
  return Math.max(0, offer.seats - (offer.takers?.length ?? 0));
}

/**
 * Take or give back a seat.
 *
 * Idempotent in both directions, and it refuses to overfill: the last seat
 * going to two people at once is the normal case, not the edge one, and
 * every device resolves it the same way — log order decides, and the loser
 * sees a full car rather than a seat that quietly does not exist.
 */
export function applyTake(list, id, who, taking) {
  return (list ?? []).map((o) => {
    if (o.id !== id) return o;
    const takers = o.takers ?? [];
    if (!taking) return { ...o, takers: takers.filter((t) => t !== who) };
    if (takers.includes(who)) return o;
    if (!o.seats || takers.length >= o.seats) return o;
    return { ...o, takers: [...takers, who] };
  });
}

/** Who may take a line down: whoever posted it, or an admin. The same rule
    the noticeboard uses, for the same reason — the board belongs to the
    roster, not to whoever happens to hold a role. */
export function canRemoveOffer(offer, requester, isAdmin) {
  if (!offer) return false;
  return offer.author === requester || isAdmin === true;
}

/** Union for the joiner gap-fill: entries this device already has win over
    the incoming copy of the same id, so a claim it has seen is not undone by
    a rebroadcast that predates it. */
export function mergeOffers(mine, incoming) {
  const have = new Set((mine ?? []).map((o) => o.id));
  return [...(mine ?? []), ...(incoming ?? []).filter((o) => o && !have.has(o.id))]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, OFFERS_MAX);
}

/** Bound and clean a whole list off the wire (a meta rebroadcast). */
export function normalizeOffers(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .map((o) => {
      const base = normalizeOffer(o, o?.author, now);
      if (!base) return null;
      const takers = [...new Set((Array.isArray(o.takers) ? o.takers : []).map(String))]
        .slice(0, SEATS_MAX)
        .filter((t) => t);
      return { ...base, takers: base.seats ? takers.slice(0, base.seats) : [] };
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, OFFERS_MAX);
}
