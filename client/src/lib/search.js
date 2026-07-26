// Local message search.
//
// There was none, and no copy explained why — which reads as an oversight
// rather than as the deliberate cost it is. Search here is necessarily
// device-local: the relay holds ciphertext and cannot index it, so what you
// can find is exactly what this device has decrypted and stored. A second
// device that joined later has a different answer, and that is not a bug.
//
// Everything in this file is pure. The scan over IndexedDB lives in the
// controller; the matching, ranking and snippet rules live here so they can
// be tested without a database.

/** Results returned to the palette. Past this the list stops being a list. */
export const SEARCH_LIMIT = 40;

/** Below this, a scan of every message on the device costs more than it is
 *  worth and matches everything anyway. */
export const MIN_QUERY = 2;

/** Characters of context kept around a match in the preview line. */
export const SNIPPET_WIDTH = 72;

/** Split a query into terms. Quoted runs stay together so a phrase can be
 *  searched as one, which is the only way to find "a b" without also
 *  matching every line holding an "a" and a "b" a paragraph apart. */
export function parseQuery(query) {
  const terms = [];
  for (const m of String(query ?? '').matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

/** Every term must appear somewhere in the text — AND, not OR. With OR, a
 *  two-word query returns strictly more than each word alone, which is the
 *  opposite of what typing a second word means. */
export function matchesTerms(text, terms) {
  if (terms.length === 0) return false;
  const hay = String(text ?? '').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Where the first term lands, or -1. Used to centre the snippet. */
function firstHit(text, terms) {
  const hay = String(text ?? '').toLowerCase();
  let best = -1;
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * A one-line preview centred on the match, as `{ before, match, after }` so
 * the caller can mark the hit without interpolating HTML. Returns the head of
 * the line when nothing matches, rather than an empty preview.
 */
export function snippet(text, terms, width = SNIPPET_WIDTH) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  const at = firstHit(src, terms);
  if (at < 0) {
    return {
      before: src.length > width ? `${src.slice(0, width)}…` : src,
      match: '',
      after: '',
    };
  }
  // Which term actually landed first — with several terms, the longest one
  // starting at `at` is the one the reader means.
  const hit = terms
    .filter((t) => src.toLowerCase().startsWith(t, at))
    .reduce((a, b) => (b.length > a.length ? b : a), '');

  const pad = Math.max(0, Math.floor((width - hit.length) / 2));
  const from = Math.max(0, at - pad);
  const to = Math.min(src.length, at + hit.length + pad);
  return {
    before: (from > 0 ? '…' : '') + src.slice(from, at),
    match: src.slice(at, at + hit.length),
    after: src.slice(at + hit.length, to) + (to < src.length ? '…' : ''),
  };
}

/** The text of a message as search sees it. Attachments are findable by
 *  filename — the bytes are opaque, but the name is the only handle anyone
 *  remembers a file by. */
export function searchableText(m) {
  return [m?.text, m?.file?.name].filter(Boolean).join(' ');
}

/**
 * Match and rank messages, returning `{ hits, truncated }`.
 *
 * `rows` are `{ server, channel, message }`. Ranking is newest-first and
 * nothing else: relevance scoring over a few thousand personal messages
 * mostly produces surprises, whereas "the most recent time this was said" is
 * what people are actually reconstructing.
 *
 * `truncated` is reported rather than inferred so the UI can say the list was
 * cut, instead of implying these are all the matches there are.
 */
export function rankHits(rows, query, { limit = SEARCH_LIMIT } = {}) {
  const terms = parseQuery(query);
  if (terms.length === 0 || String(query ?? '').trim().length < MIN_QUERY) {
    return { hits: [], truncated: false };
  }
  const hits = [];
  for (const row of rows ?? []) {
    const m = row?.message;
    // System chips are chrome, not conversation — the same rule the unread
    // counts use.
    if (!m || m.system) continue;
    const text = searchableText(m);
    if (!matchesTerms(text, terms)) continue;
    hits.push({
      server: row.server,
      channel: row.channel,
      sender: m.sender,
      ts: Number(m.ts) || 0,
      snippet: snippet(text, terms),
    });
  }
  hits.sort((a, b) => b.ts - a.ts);
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}
