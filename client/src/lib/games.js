// The game shelf: pure rules for the circle's game registry. Games live on
// other servers — quorum only keeps sealed pointers to them. The registry
// rides inside the overview payload, so it crosses devices in MLS envelopes
// and reaches joiners via the metadata rebroadcast and the encrypted backup;
// the relay never learns what a circle plays. Same discipline as overview.js:
// whitelisted fields, bounded sizes, no I/O.

export const GAMES_MAX = 24;
export const GAME_NAME_MAX = 60;
export const GAME_URL_MAX = 2048;
export const GAME_NOTE_MAX = 140;

/** Two kinds of game:
    - 'activity': a web game, embedded in the app in a sandboxed iframe
    - 'server':   a native game server (Minecraft, Factorio…) — an address
                  card; joining happens in the game's own client. */
const KINDS = new Set(['activity', 'server']);

export function normalizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  const id = String(g.id ?? '').slice(0, 40);
  const name = String(g.name ?? '').slice(0, GAME_NAME_MAX).trim();
  const url = String(g.url ?? '').slice(0, GAME_URL_MAX).trim();
  const kind = KINDS.has(g.kind) ? g.kind : 'activity';
  const note = String(g.note ?? '').slice(0, GAME_NOTE_MAX).trim();
  // Cover mark: a short glyph/emoji the registrar picked (♞, 🏰, …).
  // Bounded hard — it renders big on the cover, never as markup.
  const glyph = String(g.glyph ?? '').trim().slice(0, 4);
  if (!id || !name || !url) return null;
  if (kind === 'activity' && !activitySrc(url)) return null;
  return { id, name, url, kind, ...(note ? { note } : {}), ...(glyph ? { glyph } : {}) };
}

export function normalizeGames(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, GAMES_MAX)
    .map(normalizeGame)
    .filter(Boolean);
}

/** What an activity iframe may load: https:// anywhere, or a same-origin
    path ("/games/…") for bundled demos. Anything else — javascript:, data:,
    protocol-relative — is refused so a hostile envelope can't turn the
    shelf into a script injector. */
export function activitySrc(url) {
  if (/^https:\/\//i.test(url)) return url;
  if (/^\/[^/\\]/.test(url)) return url;
  return null;
}

/** Display host for the honesty line: where this game actually lives. */
export function gameHost(game) {
  if (game.kind === 'server') return game.url;
  try {
    const u = new URL(game.url, 'https://this-app');
    return u.host === 'this-app' ? 'bundled with this app' : u.host;
  } catch {
    return game.url;
  }
}

/** A game *reference* as carried inside a chat message ("bob opened X").
    Deliberately has no URL: the card resolves against the circle's own
    registry at click time, so a chat envelope can never point a Join
    button somewhere the shelf doesn't. */
export function normalizeGameRef(g) {
  if (!g || typeof g !== 'object') return null;
  const id = String(g.id ?? '').slice(0, 40);
  const name = String(g.name ?? '').slice(0, GAME_NAME_MAX).trim();
  const kind = KINDS.has(g.kind) ? g.kind : 'activity';
  if (!id || !name) return null;
  return { id, name, kind };
}

export function makeGameId(now = Date.now()) {
  return `g${now.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Device-local memory of the shelf: when did THIS device last launch each
// game. Deliberately not shared — it needs no protocol and never lies.
const LAST_PLAYED_KEY = 'quorum-last-played';

export function lastPlayed(gameId) {
  try {
    return JSON.parse(localStorage.getItem(LAST_PLAYED_KEY) ?? '{}')[gameId] ?? null;
  } catch {
    return null;
  }
}

export function markPlayed(gameId, now = Date.now()) {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_PLAYED_KEY) ?? '{}');
    map[gameId] = now;
    localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(map));
  } catch {
    // private mode etc. — the card just shows nothing
  }
}

/** A presence claim as received: which game (if any) a member is in right
    now. Fresh for four hours, then treated as expired by readers. */
export const PRESENCE_TTL = 4 * 3600e3;

export function normalizePresence(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return { playing: null, ts: now };
  const playing = normalizeGameRef(p.playing);
  return { playing, ts: now };
}

export function freshPresence(entry, now = Date.now()) {
  if (!entry?.playing) return null;
  return now - entry.ts < PRESENCE_TTL ? entry.playing : null;
}
