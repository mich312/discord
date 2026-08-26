// Who is here right now — one answer, for every surface that asks.
//
// The roster's rule is the honest one and it is the one that spreads: this
// device shows presence it actually knows about, which is who is in a call
// (MLS voice signaling) and who says they are in a game (MLS rich presence,
// expired client-side). There is no "online" dot, because there is no
// heartbeat behind one — a member with the tab open and nothing happening is
// indistinguishable, to us, from a member who closed it.
//
// Circles home says "3 here now" on a card and the roster lists them by name.
// Those two numbers disagreeing is the kind of bug nobody files and everybody
// notices, so both read it from here.

import { freshPresence } from './games.js';

/**
 * Presence for one circle.
 *
 * `inRoom`  handle → the voice room they are in (first one wins)
 * `playing` handle → {game, ts} for a still-fresh claim
 * `live`    members who are in a call or in a game, in roster order
 *
 * Non-members are dropped from `live` on purpose: voice presence is keyed by
 * room, and a stale entry for somebody who has since left the circle would
 * otherwise be counted as one of its people.
 */
export function circlePresence(server, voice, now = Date.now()) {
  const inRoom = {};
  for (const room of server.voiceChannels ?? ['lounge']) {
    for (const p of voice?.presence?.[`${server.id}/${room}`] ?? []) {
      if (!(p in inRoom)) inRoom[p] = room;
    }
  }
  const playing = {};
  for (const [handle, entry] of Object.entries(server.presence ?? {})) {
    const game = freshPresence(entry, now);
    if (game) playing[handle] = { game, ts: entry.ts };
  }
  const members = server.members ?? [];
  const live = members.filter((m) => m in inRoom || m in playing);
  return { inRoom, playing, live };
}
