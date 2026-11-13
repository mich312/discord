import React, { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { canRemoveOffer, seatsLeft } from '../lib/offers.js';
import { awaitingFrom, normalizeThreshold, standingSignatures } from '../lib/quorum.js';
import {
  describeAgo,
  describeUntil,
  canRemoveNotice,
  upcomingEvents,
} from '../lib/overview.js';
import {
  freshPresence,
  freshWant,
  gameHost,
  lastPlayed,
  playCount,
  isFavorite,
  toggleFavorite,
  matchesFilter,
  sortGames,
  makeGameId,
  normalizeGame,
} from '../lib/games.js';
import { nameHue } from '../lib/avatar.js';
import { Hash, Wave, Bell, Clock, LinkGlyph, Plus, X, ArrowRight, Gamepad, External, Copy, Check, Gear, Star, Server } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The circle's game hub. Two faces off one page, so the thing the page is
// named for leads:
//   · Play — what's live right now, and the shelf of games to start. The
//            live band takes the top when anyone's in a game; the cards
//            below adapt (join / launch / copy) and can be starred, filtered
//            and sorted live-first.
//   · Home — the circle briefing that used to crowd the top: the next event
//            with its countdown + RSVP, the per-room catch-up, the
//            noticeboard, pinned links, and the blurb.
// Which face you're on is remembered per-device; nothing here changed about
// what crosses the wire. Every synced word still travels inside MLS; the
// relay reads none of it. What the relay CAN'T hide — that connecting to a
// game shows that game's host your traffic — the shelf still says plainly.

// Only ever link out to http(s) — anything else renders as inert text, so
// a pinned "javascript:" or "data:" URL can't become a click target.
function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

// datetime-local <-> ms, in the device's own timezone.
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const FILTER_LABEL = {
  all: 'All',
  live: 'Live',
  favorites: 'Starred',
  recent: 'Recent',
  web: 'Web',
  servers: 'Servers',
};

// "you want to play" / "alice wants to play" / "alice & bob want to play" /
// "3 want to play" — verb agrees with the count, "you" replaces my own name.
function ralliersLabel(who, me) {
  const name = (h) => (h === me ? 'you' : h);
  if (who.length === 1) {
    return who[0] === me ? 'You want to play' : `${who[0]} wants to play`;
  }
  if (who.length === 2) return `${name(who[0])} and ${name(who[1])} want to play`;
  return `${who.length} want to play`;
}

let linkSeq = 0;
let eventSeq = 0;

// The events an EditForm starts from — the new array, or a lone legacy event,
// or one blank row so the form always has a place to type (and so the first
// row's fields keep their stable ids).
function seedEvents(overview) {
  const src = overview?.events?.length
    ? overview.events
    : overview?.event
      ? [overview.event]
      : [];
  const rows = src.map((e) => ({
    _id: ++eventSeq,
    id: e.id,
    title: e.title ?? '',
    at: toLocalInput(e.at),
    note: e.note ?? '',
    gameId: e.gameId ?? '',
  }));
  return rows.length ? rows : [{ _id: ++eventSeq, title: '', at: '', note: '', gameId: '' }];
}

function EditForm({ overview, games, onSave, onCancel }) {
  const [blurb, setBlurb] = useState(overview?.blurb ?? '');
  // Each row gets a stable local id: with index keys, removing a middle
  // link makes React reuse the wrong controlled inputs for the rows below.
  const [links, setLinks] = useState(() =>
    (overview?.links ?? []).map((l) => ({ ...l, _id: ++linkSeq }))
  );
  const [events, setEvents] = useState(() => seedEvents(overview));

  const setLink = (i, patch) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setEvent = (i, patch) =>
    setEvents((es) => es.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <form
      className="overview-edit-form"
      data-testid="overview-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          blurb: blurb.trim(),
          links: links.map(({ _id, ...l }) => l),
          events: events
            .map((ev) => ({
              ...(ev.id ? { id: ev.id } : {}),
              title: ev.title.trim(),
              at: ev.at ? new Date(ev.at).getTime() : NaN,
              note: ev.note.trim(),
              ...(ev.gameId ? { gameId: ev.gameId } : {}),
            }))
            .filter((ev) => ev.title && Number.isFinite(ev.at)),
        });
      }}
    >
      <label className="overview-field-label">Events</label>
      {events.map((ev, i) => (
        <div className="overview-event-row" key={ev._id}>
          <div className="overview-event-edit">
            <input
              value={ev.title}
              onChange={(e) => setEvent(i, { title: e.target.value })}
              placeholder="What’s happening (leave empty to remove)"
              data-testid={i === 0 ? 'overview-event-title' : `overview-event-title-${i}`}
            />
            <input
              type="datetime-local"
              value={ev.at}
              onChange={(e) => setEvent(i, { at: e.target.value })}
              data-testid={i === 0 ? 'overview-event-at' : `overview-event-at-${i}`}
            />
          </div>
          <div className="overview-event-edit2">
            <input
              value={ev.note}
              onChange={(e) => setEvent(i, { note: e.target.value })}
              placeholder="Where, what to bring (optional)"
              data-testid={i === 0 ? 'overview-event-note' : `overview-event-note-${i}`}
            />
            <select
              value={ev.gameId}
              onChange={(e) => setEvent(i, { gameId: e.target.value })}
              aria-label="Game for this event"
              data-testid={`overview-event-game-${i}`}
            >
              <option value="">No game</option>
              {games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            {events.length > 1 && (
              <button
                type="button"
                className="ghost"
                aria-label="Remove event"
                title="Remove event"
                onClick={() => setEvents((es) => es.filter((_, j) => j !== i))}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="ghost overview-add-link"
        data-testid="overview-add-event"
        onClick={() =>
          setEvents((es) => [...es, { _id: ++eventSeq, title: '', at: '', note: '', gameId: '' }])
        }
      >
        <Plus size={14} />
        Add an event
      </button>
      <label className="overview-field-label">About this circle</label>
      <textarea
        aria-label="About this circle"
        data-testid="overview-blurb-input"
        rows={4}
        value={blurb}
        onChange={(e) => setBlurb(e.target.value)}
        placeholder={'What is this circle for? House rules, cadence, where to start…'}
      />
      <label className="overview-field-label">Links</label>
      {links.map((l, i) => (
        <div className="overview-link-edit" key={l._id}>
          <input
            value={l.label}
            onChange={(e) => setLink(i, { label: e.target.value })}
            placeholder="Label"
            data-testid={`overview-link-label-${i}`}
          />
          <input
            value={l.url}
            onChange={(e) => setLink(i, { url: e.target.value })}
            placeholder="https://…"
            data-testid={`overview-link-url-${i}`}
          />
          <button
            type="button"
            className="ghost"
            aria-label="Remove link"
            title="Remove link"
            onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost overview-add-link"
        data-testid="overview-add-link"
        onClick={() => setLinks((ls) => [...ls, { label: '', url: '', _id: ++linkSeq }])}
      >
        <Plus size={14} />
        Add a link
      </button>
      <div className="row overview-edit-actions">
        <button className="button primary" type="submit" data-testid="overview-save">
          Save changes
        </button>
        <button className="button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="fineprint muted">
        Everyone in the circle sees this page. Links open only if they start with https://;
        anything else stays plain text.
      </p>
    </form>
  );
}

// The live band: the Play view's top slot when anyone in the circle is in a
// game. It leads with who's in and one green way to join them — a door, not
// a status line. Falls back to nothing when the circle is quiet.
function LiveBand({ game, players, me, onJoin }) {
  const [copied, setCopied] = useState(false);
  const hue = nameHue(game.name);
  const who = players.map((p) => (p === me ? 'you' : p));
  const isServer = game.kind === 'server';
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(game.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard denied — the address is still on the game's card below
    }
  };
  return (
    <section className="hub-band" data-testid="hub-live-band">
      <div
        className="hub-band-cover"
        style={{ background: `hsl(${hue} 38% 30%)` }}
        aria-hidden="true"
      >
        <span className={cx('game-cover-mark', game.glyph && 'glyph')}>
          {game.glyph ?? game.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
      <div className="hub-band-body">
        <strong className="hub-band-title">{game.name}</strong>
        <span className="hub-band-who">
          <span className="game-who-stack">
            {players.slice(0, 4).map((p) => (
              <Seal key={p} name={p} size={20} title={p} />
            ))}
          </span>
          <span className="live-dot" aria-hidden="true" />
          {who.length === 1
            ? `${who[0] === 'you' ? 'You are' : `${who[0]} is`} playing now`
            : who.length <= 3
              ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are playing now`
              : `${who.length} playing now`}
        </span>
      </div>
      {isServer ? (
        <button className="button" data-testid="hub-band-copy" onClick={copyAddress}>
          <Copy size={14} />
          {copied ? 'Copied' : 'Copy address'}
        </button>
      ) : (
        <button className="button hub-band-join" data-testid="hub-band-join" onClick={onJoin}>
          <Gamepad size={14} />
          Join
        </button>
      )}
    </section>
  );
}

// One game on the shelf. The cover carries the game's own hue (derived from
// its name, like a member's orb); the primary action reads the game's state —
// join when the circle's already in it, launch when it's quiet, copy for a
// native server — so one glance tells you the next move.
function GameCard({ game, players, canManage, rallied, onLaunch, onRally, onRemove, onFavorite }) {
  const [copied, setCopied] = useState(false);
  const [fav, setFav] = useState(() => isFavorite(game.id));
  const hue = nameHue(game.name);
  const host = gameHost(game);
  const played = lastPlayed(game.id);
  const plays = playCount(game.id);
  const live = players.length > 0;
  const isServer = game.kind === 'server';
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(game.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard denied — the address is printed on the card regardless
    }
  };
  const flipFav = () => {
    setFav(toggleFavorite(game.id));
    onFavorite?.();
  };
  // How the card describes itself when nobody's in it: plays first, then when
  // this device last opened it — the honest device-local memory of the shelf.
  const idleNote = [
    plays ? `${plays} play${plays === 1 ? '' : 's'}` : '',
    played ? `last played ${describeAgo(played)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={cx('game-card', live && 'live')} data-testid={`game-card-${game.id}`}>
      {/* A game's cover is its identity, the way an orb is a person's — so
          it keeps its hue. It lost the two-stop gradient and the film grain,
          which were decoration on top of the identity. */}
      <div className="game-cover" style={{ background: `hsl(${hue} 38% 30%)` }}>
        <span className={cx('game-cover-mark', game.glyph && 'glyph')}>
          {game.glyph ?? game.name.slice(0, 1).toUpperCase()}
        </span>
        {live ? (
          <span className="game-kind live" data-testid={`game-live-${game.id}`}>
            <span className="live-dot" aria-hidden="true" />
            Live
          </span>
        ) : (
          <span className="game-kind">{isServer ? 'Game server' : 'Web game'}</span>
        )}
        {canManage && (
          <button
            className="ghost game-remove"
            aria-label={`Remove ${game.name} from the shelf`}
            title="Remove from the shelf"
            data-testid={`game-remove-${game.id}`}
            onClick={onRemove}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="game-body">
        <div className="game-name-row">
          <span className="game-name">{game.name}</span>
          {/* §6.1 — an icon from the set, not ★ and ☆ standing in for one. */}
          <button
            className={cx('game-fav', fav && 'on')}
            aria-label={fav ? `Unstar ${game.name}` : `Star ${game.name}`}
            title={fav ? 'Unstar' : 'Star to keep it at the front'}
            aria-pressed={fav}
            data-testid={`game-favorite-${game.id}`}
            onClick={flipFav}
          >
            <Star size={14} filled={fav} />
          </button>
        </div>
        <span className={cx('game-host', host && 'mono')}>
          {isServer ? <Server size={14} /> : <External size={14} />}
          {host ?? 'Runs inside quorum'}
        </span>
        {game.note && <span className="game-note">{game.note}</span>}
        {live ? (
          <span className="game-who">
            <span className="game-who-stack">
              {players.slice(0, 3).map((p) => (
                <Seal key={p} name={p} size={20} title={p} />
              ))}
            </span>
            {players.length === 1 ? `${players[0]} is playing` : `${players.length} playing now`}
          </span>
        ) : idleNote ? (
          <span className="game-who muted">{idleNote}</span>
        ) : null}
        <div className="game-actions">
          {isServer ? (
            <button className="button" data-testid={`game-copy-${game.id}`} onClick={copyAddress}>
              <Copy size={14} />
              {copied ? 'Copied' : 'Copy address'}
            </button>
          ) : live ? (
            <>
              <button
                className="button"
                data-testid={`game-join-${game.id}`}
                onClick={onLaunch}
              >
                <Gamepad size={14} />
                Join
              </button>
              <a
                className="button icon-only"
                aria-label={`Open ${game.name} in a new tab`}
                title="Open in a new tab"
                href={game.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <External size={14} />
              </a>
            </>
          ) : (
            <>
              <button className="button" data-testid={`game-launch-${game.id}`} onClick={onLaunch}>
                <Gamepad size={14} />
                Play
              </button>
              <a
                className="button icon-only"
                aria-label={`Open ${game.name} in a new tab`}
                title="Open in a new tab"
                href={game.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <External size={14} />
              </a>
            </>
          )}
        </div>
        {!live && onRally && (
          <button
            className={cx('game-rally', rallied && 'on')}
            data-testid={`game-rally-${game.id}`}
            aria-pressed={rallied}
            onClick={() => onRally(rallied ? null : game)}
          >
            <Bell size={14} />
            {rallied ? 'Waiting for others. Cancel rally' : 'Ask the circle to play'}
          </button>
        )}
      </div>
    </li>
  );
}

function AddGameForm({ onAdd, onCancel }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState('activity');
  const [glyph, setGlyph] = useState('');
  return (
    <form
      className="game-add-form"
      data-testid="game-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        const game = normalizeGame({ id: makeGameId(), name, url, kind, glyph });
        if (!game) return;
        onAdd(game);
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Game name"
        aria-label="Game name"
        data-testid="game-add-name"
      />
      <div className="game-add-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={kind === 'server' ? 'Address, e.g. mc.example.net:25565' : 'https:// address'}
          aria-label={kind === 'server' ? 'Server address' : 'Web address'}
          data-testid="game-add-url"
        />
        <input
          className="game-add-glyph"
          value={glyph}
          onChange={(e) => setGlyph(e.target.value)}
          placeholder="♞"
          aria-label="Cover mark: one character (optional)"
          title="Cover mark: one character (optional)"
          data-testid="game-add-glyph"
        />
      </div>
      <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="game-add-kind">
        <option value="activity">Web game: plays inside quorum</option>
        <option value="server">Game server: join with its own app</option>
      </select>
      <div className="row">
        <button className="button primary" type="submit" data-testid="game-add-save">
          Add to shelf
        </button>
        <button className="button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function Overview({
  server,
  me,
  canManage,
  canSend,
  voice,
  digestKey,
  loadDigest,
  onSelectChannel,
  onVoiceJoin,
  onLaunchGame,
  onRally,
  onRsvp,
  onSave,
  onAddNotice,
  onRemoveNotice,
  onAddOffer,
  onTakeOffer,
  onRemoveOffer,
  onOpenProposal,
  onCircleSettings,
  // The roster, rendered by the parent so the trust actions it carries
  // (verify, add, remove, call) stay wired in one place.
  people,
}) {
  const [editing, setEditing] = useState(false);
  const [addingGame, setAddingGame] = useState(false);
  const [filter, setFilter] = useState('all');
  // Bumped when a card's star flips, so the shelf re-sorts live-first /
  // starred / recent without the parent tracking each card's state.
  const [favTick, setFavTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [offerDraft, setOfferDraft] = useState('');
  const [offerSeats, setOfferSeats] = useState('');
  const [digest, setDigest] = useState([]);
  // Countdown and "x min ago" labels drift; tick them along while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Re-pull the digest whenever anything landed for this circle
  // (digestKey folds in lastSeq + the local-store revision).
  useEffect(() => {
    let alive = true;
    loadDigest(server.id).then((d) => alive && setDigest(d));
    return () => {
      alive = false;
    };
    // loadDigest is an inline prop; keying on it would refire per render.
  }, [server.id, digestKey]);

  const overview = server.overview ?? null;
  const games = overview?.games ?? [];
  const gamesById = Object.fromEntries(games.map((g) => [g.id, g]));
  // The schedule: the events array, or a lone legacy event from an older
  // client's payload. A just-passed event lingers as "up next" for a grace
  // window, then drops out of the upcoming list.
  const upcoming = upcomingEvents(overview, now);
  const soonest = upcoming[0] ?? null;
  // Game nights: upcoming events tied to a game still on the shelf — these
  // also surface on the Play tab, next to the shelf they belong with.
  const gameNights = upcoming.filter((e) => e.gameId && gamesById[e.gameId]);
  // Who said "I'm in" for the event at this timestamp (RSVPs key on the time).
  const goingFor = (at) =>
    Object.entries(server.rsvps ?? {})
      .filter(([, v]) => v.at === at)
      .map(([handle]) => handle);
  // Live claims: game id -> member handles playing it right now.
  const playingBy = {};
  for (const [handle, entry] of Object.entries(server.presence ?? {})) {
    const g = freshPresence(entry, now);
    if (g) (playingBy[g.id] ??= []).push(handle);
  }
  const liveGames = games.filter((g) => (playingBy[g.id] ?? []).length > 0);
  // Open rallies: game -> who wants to play it right now. A game that's
  // already live is joinable, so presence supersedes its rally; a rally for
  // a game no longer on the shelf is dropped (nothing to launch).
  const wantBy = {};
  for (const [handle, entry] of Object.entries(server.wants ?? {})) {
    const w = freshWant(entry, now);
    if (!w) continue;
    const g = games.find((x) => x.id === w.id);
    if (!g || (playingBy[g.id]?.length ?? 0) > 0) continue;
    (wantBy[g.id] ??= { game: g, who: [] }).who.push(handle);
  }
  const rallies = Object.values(wantBy);
  const myWant = freshWant(server.wants?.[me], now);
  // The band features whoever has the most players in; ties go to a web game,
  // since that one you can actually join in place.
  const bandGame = liveGames
    .slice()
    .sort((a, b) => {
      const byPlayers = (playingBy[b.id]?.length ?? 0) - (playingBy[a.id]?.length ?? 0);
      if (byPlayers) return byPlayers;
      return (a.kind === 'server' ? 1 : 0) - (b.kind === 'server' ? 1 : 0);
    })[0];

  // Device-local + presence truths, as pure accessors the shelf rules read.
  // favTick is referenced so a star flip recomputes the order.
  void favTick;
  const facts = {
    isLive: (id) => (playingBy[id]?.length ?? 0) > 0,
    isFav: (id) => isFavorite(id),
    playedAt: (id) => lastPlayed(id),
  };
  const shownGames = sortGames(
    games.filter((g) => matchesFilter(g, filter, facts)),
    facts
  );
  // Offer a filter chip only when it would land on something — no dead ends.
  const filterChips = ['all'].concat(
    ['live', 'favorites', 'recent', 'web', 'servers'].filter((f) =>
      games.some((g) => matchesFilter(g, f, facts))
    )
  );
  const showFilters = games.length >= 3 && filterChips.length > 2;

  const saveGames = (next) => onSave({ ...(overview ?? {}), games: next });
  const notices = server.notices ?? [];
  const offers = server.offers ?? [];
  // Membership is the circle's decision, so the board carries the ledger.
  const proposals = server.proposals ?? [];
  const threshold = normalizeThreshold(server.threshold, (server.members ?? []).length);
  const voiceRooms = server.voiceChannels ?? ['lounge'];
  const byChannel = Object.fromEntries(digest.map((d) => [d.channel, d]));
  // Catch-up order: unread rooms first, then most recently active.
  const rooms = [...server.channels].sort((a, b) => {
    const da = byChannel[a] ?? { unread: 0, last: null };
    const db = byChannel[b] ?? { unread: 0, last: null };
    if (!!da.unread !== !!db.unread) return da.unread ? -1 : 1;
    return (db.last?.ts ?? 0) - (da.last?.ts ?? 0);
  });

  const launchFromShelf = (g) => {
    setAddingGame(false);
    onLaunchGame(g);
  };

  const admins = (server.members ?? []).filter((m) => server.roles?.[m] === 'admin');
  const whenOf = (at) =>
    new Date(at).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const hasSide =
    upcoming.length > 1 ||
    canSend ||
    notices.length > 0 ||
    offers.length > 0 ||
    (overview?.links?.length ?? 0) > 0;

  return (
    <main className="messages-pane overview-pane" data-testid="overview-pane">
      <header className="pane-head">
        {/* "board", not "game hub". Two of the three circles this product is
            for have no games in them, and naming the landing page after the
            one module some circles never populate is the intent drift the
            floor plan is correcting. */}
        <h2 className="room-name">{server.name}&rsquo;s board</h2>
        {!editing && (
          <span className="pane-actions">
            {canManage && (
              <button className="button" data-testid="overview-edit" onClick={() => setEditing(true)}>
                Edit board
              </button>
            )}
            {canManage && !addingGame && (
              <button className="button" data-testid="game-add" onClick={() => setAddingGame(true)}>
                <Plus size={14} />
                Add a game
              </button>
            )}
            {/* The circle's own settings — its name, its face, how many
                signatures it asks for, and leaving it. Not admin-gated: the
                only way out of a circle is in that dialog, and gating the
                exit on a role would be the product deciding who may leave. */}
            <button
              className="ghost"
              aria-label={`${server.name} settings`}
              title={`${server.name} settings`}
              data-testid="circle-settings"
              onClick={onCircleSettings}
            >
              <Gear size={18} />
            </button>
          </span>
        )}
      </header>
      <div className="scroll overview-scroll">
        {editing ? (
          <section className="overview-section">
            <h3 className="overline">Edit board</h3>
            <EditForm
              // Remount when a remote edit lands while the form is open:
              // saving a form seeded from the old overview would silently
              // overwrite the other admin's newer changes.
              key={JSON.stringify([overview?.blurb, overview?.links, overview?.events, overview?.event])}
              overview={overview}
              games={games}
              onSave={(ov) => {
                setEditing(false);
                // The form edits the written half; the shelf rides along.
                onSave({ ...ov, games });
              }}
              onCancel={() => setEditing(false)}
            />
          </section>
        ) : (
          // Two columns from 1081px: what needs you and who is here on the
          // left, the circle's notes and plans on the right. It used to be one
          // column of blocks at four different widths, so nothing in it
          // shared a right edge. Below 1081px the side column follows the
          // main one.
          <div className={cx('board', hasSide && 'with-side')}>
            <div className="board-main">
              {overview?.blurb ? (
                <p className="overview-blurb" data-testid="overview-blurb">
                  {overview.blurb}
                </p>
              ) : (
                // §11.10 — an empty state names the next action and who can
                // take it, by name.
                <p className="overview-blurb placeholder muted" data-testid="overview-blurb-empty">
                  {canManage
                    ? 'Nothing here yet. Use Edit board to describe this circle, set an event and pin links.'
                    : admins.length
                      ? `Nothing here yet. ${admins.join(', ')} can describe this circle.`
                      : 'Nothing here yet.'}
                </p>
              )}

              {/* Who is waiting to get in. Draws only when somebody is — a
                  circle with nobody proposed should not carry an empty
                  governance block, and the roster below carries the propose
                  form. A proposal waiting on you is the one primary action
                  on the board. */}
              {proposals.length > 0 && (
                <section className="overview-section" data-testid="overview-proposals">
                  <h3 className="overline">Wants to join</h3>
                  <ul className="overview-proposals">
                    {proposals.map((p) => {
                      const signed = standingSignatures(p, server.members).length;
                      const togo = Math.max(0, threshold - signed);
                      const mine = awaitingFrom(p, me);
                      return (
                        <li
                          className={cx('proposal-row', mine && 'awaiting')}
                          key={p.id}
                          data-testid={`overview-proposal-${p.id}`}
                        >
                          <Seal name={p.handle} size={32} title={p.handle} />
                          <div className="proposal-body">
                            <span className="proposal-who">
                              <strong>{p.handle}</strong> wants to join
                            </span>
                            {/* §1.6 — the count is the state, in words, and it
                                does not lean on the border colour to say it.
                                §4.4 — these are the facts a decision rests on,
                                so they are set to be read, not in capitals. */}
                            <span className="proposal-head">
                              Proposed by {p.by === me ? 'you' : p.by} · {signed} of {threshold} signed
                              {togo === 0 && ' · enough to join'}
                              {p.objections.length > 0 &&
                                ` · ${p.objections.length} objection${p.objections.length === 1 ? '' : 's'}`}
                            </span>
                            <span className="proposal-meter" role="img" aria-label={`${signed} of ${threshold} signed`}>
                              {Array.from({ length: threshold }, (_, i) => (
                                <span key={i} className={cx('pip', i < signed && 'on')} />
                              ))}
                            </span>
                          </div>
                          <button
                            className={cx('button', 'proposal-open', mine && 'primary')}
                            data-testid={`overview-proposal-open-${p.id}`}
                            onClick={() => onOpenProposal?.(p.id)}
                          >
                            {mine ? 'Review' : 'View'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {soonest &&
                (() => {
                  const going = goingFor(soonest.at);
                  const iAmIn = going.includes(me);
                  const heroGame = soonest.gameId ? gamesById[soonest.gameId] : null;
                  return (
                    <section className="overview-upnext hub-hero" data-testid="overview-event">
                      <div className="hub-hero-meta">
                        <h3 className="hub-hero-tag">Up next</h3>
                        <span className="upnext-when">
                          {whenOf(soonest.at)} ·{' '}
                          <span data-testid="overview-countdown">{describeUntil(soonest.at, now)}</span>
                        </span>
                      </div>
                      <strong className="upnext-title hub-hero-title">{soonest.title}</strong>
                      {soonest.note && <p className="upnext-note">{soonest.note}</p>}
                      <div className="hub-rsvp">
                        {canSend && (
                          <button
                            className={cx('button', iAmIn ? 'pressed' : !proposals.some((p) => awaitingFrom(p, me)) && 'primary')}
                            aria-pressed={iAmIn}
                            data-testid="rsvp-toggle"
                            onClick={() => onRsvp(soonest.at, !iAmIn)}
                          >
                            {iAmIn && <Check size={14} />}
                            {iAmIn ? 'Going' : 'I’m in'}
                          </button>
                        )}
                        {going.length > 0 && (
                          <span className="hub-going" data-testid="rsvp-going">
                            <span className="hub-going-stack">
                              {going.slice(0, 5).map((p) => (
                                <Seal key={p} name={p} size={20} title={p} />
                              ))}
                            </span>
                            {going.length} going
                          </span>
                        )}
                        {heroGame && (
                          <button className="hero-game" onClick={() => heroGame.kind !== 'server' && launchFromShelf(heroGame)}>
                            <Gamepad size={14} />
                            {heroGame.name}
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })()}

              {/* The circle opens on its people. At six members the roster was
                  the densest thing on screen and it lived in a column beside
                  the conversation, which is where you look last. */}
              {people}

              <section className="overview-section">
                <h3 className="overline">Rooms</h3>
                <ul className="overview-rooms">
                  {rooms.map((ch) => {
                    const d = byChannel[ch] ?? { unread: 0, last: null };
                    const topic = server.chanMeta?.[ch]?.topic;
                    return (
                      <li key={ch}>
                        <button
                          className={cx('overview-room', d.unread && 'has-unread')}
                          data-testid={`overview-room-${ch}`}
                          onClick={() => onSelectChannel(ch)}
                        >
                          <span className="glyph">
                            <Hash size={14} />
                          </span>
                          <span className="room">{ch}</span>
                          {d.unread > 0 && (
                            <span className="unread-badge" data-testid={`overview-unread-${ch}`}>
                              {d.unread}
                            </span>
                          )}
                          <span className="last">
                            {d.last ? `${d.last.sender}: ${d.last.text}` : topic ?? 'Nothing here yet'}
                          </span>
                          <span className="when">{d.last ? describeAgo(d.last.ts, now) : ''}</span>
                          <span className="go">
                            <ArrowRight size={14} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {voiceRooms.map((ch) => {
                    const present = voice?.presence?.[`${server.id}/${ch}`] ?? [];
                    return (
                      <li key={`v:${ch}`}>
                        <button
                          className={cx('overview-room', 'voice', present.length && 'live')}
                          data-testid={`overview-voice-${ch}`}
                          onClick={() => onVoiceJoin(ch)}
                        >
                          <span className="glyph">
                            <Wave size={14} />
                          </span>
                          <span className="room">{ch}</span>
                          <span className="last">
                            {present.length ? `In call: ${present.join(', ')}` : 'Nobody in the call'}
                          </span>
                          <span className="go">{present.length ? 'Join' : 'Start a call'}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {bandGame ? (
                <LiveBand
                  game={bandGame}
                  players={playingBy[bandGame.id] ?? []}
                  me={me}
                  onJoin={() => launchFromShelf(bandGame)}
                />
              ) : games.length > 0 && rallies.length === 0 ? (
                <p className="hub-nudge" data-testid="hub-quiet">
                  Nobody&rsquo;s playing right now. Start a game below, or ask the circle to play.
                </p>
              ) : null}

              {rallies.length > 0 && (
                <section className="hub-rallies" data-testid="hub-rallies">
                  <h3 className="overline">Want to play</h3>
                  <ul className="rally-list">
                    {rallies.map(({ game: g, who }) => (
                      <li className="rally-row" key={g.id} data-testid={`rally-${g.id}`}>
                        <span className="game-who-stack">
                          {who.slice(0, 3).map((p) => (
                            <Seal key={p} name={p} size={22} title={p} />
                          ))}
                        </span>
                        <span className="rally-text">
                          {ralliersLabel(who, me)} <strong>{g.name}</strong>
                        </span>
                        {g.kind === 'server' ? (
                          <span className="rally-host mono">{gameHost(g)}</span>
                        ) : (
                          <button
                            className="button rally-join"
                            data-testid={`rally-join-${g.id}`}
                            onClick={() => launchFromShelf(g)}
                          >
                            <Gamepad size={14} />
                            Join
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {gameNights.length > 0 && (
                <section className="hub-nights" data-testid="hub-nights">
                  <h3 className="overline">Game nights</h3>
                  <ul className="nights-list">
                    {gameNights.map((ev) => {
                      const g = gamesById[ev.gameId];
                      const going = goingFor(ev.at);
                      const iAmIn = going.includes(me);
                      const live = (playingBy[g.id]?.length ?? 0) > 0;
                      return (
                        <li className="night-row" key={ev.id} data-testid={`night-${ev.id}`}>
                          <span className="night-mark" aria-hidden="true">
                            <Clock size={14} />
                          </span>
                          <div className="night-body">
                            <span className="night-title">
                              {ev.title} <span className="night-game">· {g.name}</span>
                            </span>
                            <span className="night-when">
                              {whenOf(ev.at)} · {describeUntil(ev.at, now)}
                              {ev.note ? `. ${ev.note}` : ''}
                            </span>
                          </div>
                          {going.length > 0 && (
                            <span className="night-going" data-testid={`night-going-${ev.id}`}>
                              <span className="game-who-stack">
                                {going.slice(0, 3).map((p) => (
                                  <Seal key={p} name={p} size={20} title={p} />
                                ))}
                              </span>
                              {going.length} going
                            </span>
                          )}
                          {live && g.kind !== 'server' ? (
                            <button className="button night-action" onClick={() => launchFromShelf(g)}>
                              <Gamepad size={14} />
                              Join
                            </button>
                          ) : (
                            canSend && (
                              <button
                                className={cx('button', 'night-action', iAmIn && 'pressed')}
                                aria-pressed={iAmIn}
                                data-testid={`night-rsvp-${ev.id}`}
                                onClick={() => onRsvp(ev.at, !iAmIn)}
                              >
                                {iAmIn && <Check size={14} />}
                                {iAmIn ? 'Going' : 'I’m in'}
                              </button>
                            )
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="overview-section">
                <div className="shelf-head">
                  <h3 className="overline">Games</h3>
                  {games.length > 0 && (
                    <span className="shelf-meta">
                      {games.length} game{games.length === 1 ? '' : 's'}
                      {liveGames.length > 0 && ` · ${liveGames.length} live`}
                    </span>
                  )}
                </div>

                {showFilters && (
                  <div className="shelf-filters" role="group" aria-label="Filter games">
                    {filterChips.map((f) => (
                      <button
                        key={f}
                        className={cx('fchip', filter === f && 'on')}
                        data-testid={`game-filter-${f}`}
                        aria-pressed={filter === f}
                        onClick={() => setFilter(f)}
                      >
                        {f === 'live' && <span className="live-dot" aria-hidden="true" />}
                        {f === 'favorites' && <Star size={14} />}
                        {FILTER_LABEL[f]}
                      </button>
                    ))}
                  </div>
                )}

                {games.length > 0 || canManage ? (
                  <ul className="game-shelf" data-testid="game-shelf">
                    {shownGames.map((g) => (
                      <GameCard
                        key={g.id}
                        game={g}
                        players={playingBy[g.id] ?? []}
                        canManage={canManage}
                        rallied={canSend && myWant?.id === g.id}
                        onLaunch={() => launchFromShelf(g)}
                        onRally={canSend ? onRally : undefined}
                        onRemove={() => saveGames(games.filter((x) => x.id !== g.id))}
                        onFavorite={() => setFavTick((n) => n + 1)}
                      />
                    ))}
                    {games.length > 0 && shownGames.length === 0 && (
                      <li className="shelf-empty-filter muted" data-testid="game-filter-empty">
                        No games match &ldquo;{FILTER_LABEL[filter]}&rdquo;.
                      </li>
                    )}
                    {canManage && filter === 'all' && (
                      <li className="game-card add-card">
                        {addingGame ? (
                          <AddGameForm
                            onAdd={(game) => {
                              setAddingGame(false);
                              saveGames([...games, game]);
                            }}
                            onCancel={() => setAddingGame(false)}
                          />
                        ) : (
                          <button
                            className="add-card-btn"
                            data-testid="game-add-tile"
                            onClick={() => setAddingGame(true)}
                          >
                            <span className="add-card-plus">
                              <Plus size={18} />
                            </span>
                            <span className="add-card-title">Add a game</span>
                            <span className="add-card-sub">
                              A web address is enough. It shows up for the whole circle.
                            </span>
                          </button>
                        )}
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="muted overview-empty-note" data-testid="game-shelf-empty">
                    No games yet. {admins.length ? `${admins.join(', ')} can add one.` : ''}
                  </p>
                )}
                {games.length > 0 && (
                  <p className="shelf-honesty muted" data-testid="shelf-honesty">
                    Each game runs on the server its card names. That server sees your connection,
                    never your chat.
                  </p>
                )}
              </section>
            </div>

            {hasSide && (
              <aside className="board-side" aria-label="Plans and notes">
                {upcoming.length > 1 && (
                  <section className="overview-section side-card">
                    <h3 className="overline">Calendar</h3>
                    <ul className="cal-list">
                      {upcoming.slice(1).map((ev) => {
                        const going = goingFor(ev.at);
                        const iAmIn = going.includes(me);
                        const g = ev.gameId ? gamesById[ev.gameId] : null;
                        return (
                          <li key={ev.id} className="cal-row" data-testid={`cal-${ev.id}`}>
                            <div className="cal-body">
                              <span className="cal-title">{ev.title}</span>
                              <span className="cal-when">
                                {whenOf(ev.at)} · {describeUntil(ev.at, now)}
                                {g ? ` · ${g.name}` : ''}
                              </span>
                              {ev.note && <span className="cal-note">{ev.note}</span>}
                            </div>
                            {canSend && (
                              <button
                                className={cx('button', 'cal-rsvp', iAmIn && 'pressed')}
                                aria-pressed={iAmIn}
                                data-testid={`cal-rsvp-${ev.id}`}
                                onClick={() => onRsvp(ev.at, !iAmIn)}
                              >
                                {iAmIn && <Check size={14} />}
                                {iAmIn ? 'Going' : 'I’m in'}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

                {(canSend || notices.length > 0) && (
                  <section className="overview-section side-card">
                    <h3 className="overline">Pinned</h3>
                    {notices.length ? (
                      <ul className="overview-notices">
                        {notices.map((n) => (
                          <li className="notice" key={n.id} data-testid="overview-notice">
                            <div className="notice-body">
                              <span className="notice-text">{n.text}</span>
                              <span className="notice-head">
                                {n.author} · {describeAgo(n.ts, now)}
                              </span>
                            </div>
                            {canSend && canRemoveNotice(n, me, server.roles?.[me] === 'admin') && (
                              <button
                                className="ghost notice-remove"
                                aria-label="Unpin"
                                title="Unpin"
                                data-testid={`overview-notice-remove-${n.id}`}
                                onClick={() => onRemoveNotice(n.id)}
                              >
                                <X size={14} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted overview-empty-note" data-testid="overview-notices-empty">
                        Nothing pinned yet. Pin a note the whole circle should see.
                      </p>
                    )}
                    {canSend && (
                      <form
                        className="notice-composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = draft.trim();
                          if (!text) return;
                          setDraft('');
                          onAddNotice(text);
                        }}
                      >
                        <input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="Pin a note for everyone"
                          aria-label="Pin a note for everyone"
                          data-testid="overview-notice-input"
                        />
                        <button className="button" type="submit" data-testid="overview-notice-post">
                          Pin
                        </button>
                      </form>
                    )}
                  </section>
                )}

                {/* Lifts and kit — the block that makes a race team's board
                    look like a race team's, and a photo club's like a print
                    swap. It draws only when the circle has put something in
                    it, which is what "composed per circle" means in
                    practice. */}
                {(offers.length > 0 || canSend) && (
                  <section className="overview-section side-card" data-testid="overview-offers">
                    <h3 className="overline">Lifts and kit</h3>
                    {offers.length > 0 && (
                      <ul className="overview-offers">
                        {offers.map((o) => {
                          const left = seatsLeft(o);
                          const mine = (o.takers ?? []).includes(me);
                          return (
                            <li className="offer" key={o.id} data-testid={`overview-offer-${o.id}`}>
                              <div className="offer-body">
                                <span className="offer-text">{o.text}</span>
                                <span className="offer-head">
                                  {o.author}
                                  {o.note ? ` · ${o.note}` : ''}
                                  {left !== null &&
                                    ` · ${o.seats - left} of ${o.seats} ${o.seats === 1 ? 'seat' : 'seats'} taken`}
                                </span>
                              </div>
                              {left !== null && canSend && (
                                /* §1.6 — "full" is a word, not a greyed-out
                                   button and nothing else. */
                                <button
                                  className={cx('button', 'offer-take', mine && 'pressed')}
                                  aria-pressed={mine}
                                  disabled={!mine && left === 0}
                                  data-testid={`overview-offer-take-${o.id}`}
                                  onClick={() => onTakeOffer(o.id, !mine)}
                                >
                                  {mine && <Check size={14} />}
                                  {mine ? 'You’re in' : left === 0 ? 'Full' : 'Take a seat'}
                                </button>
                              )}
                              {canSend && canRemoveOffer(o, me, server.roles?.[me] === 'admin') && (
                                <button
                                  className="ghost notice-remove"
                                  aria-label="Take this down"
                                  title="Take this down"
                                  data-testid={`overview-offer-remove-${o.id}`}
                                  onClick={() => onRemoveOffer(o.id)}
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {canSend && (
                      <form
                        className="notice-composer offer-composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = offerDraft.trim();
                          if (!text) return;
                          setOfferDraft('');
                          setOfferSeats('');
                          onAddOffer(text, Number(offerSeats) || 0);
                        }}
                      >
                        <input
                          value={offerDraft}
                          onChange={(e) => setOfferDraft(e.target.value)}
                          placeholder="A lift, a spare, where to meet"
                          aria-label="Offer a lift or kit"
                          data-testid="overview-offer-input"
                        />
                        {/* §8.7 — a real label, not a placeholder doing its job. */}
                        <label className="offer-seats">
                          <span className="sr-only">Seats, if this is a lift</span>
                          <input
                            type="number"
                            min="0"
                            max="32"
                            value={offerSeats}
                            onChange={(e) => setOfferSeats(e.target.value)}
                            placeholder="Seats"
                            data-testid="overview-offer-seats"
                          />
                        </label>
                        <button className="button" type="submit" data-testid="overview-offer-post">
                          Post
                        </button>
                      </form>
                    )}
                  </section>
                )}

                {(overview?.links?.length ?? 0) > 0 && (
                  <section className="overview-section side-card">
                    <h3 className="overline">Links</h3>
                    <ul className="overview-links">
                      {overview.links.map((l, i) => {
                        const href = safeHref(l.url);
                        return (
                          <li key={i}>
                            {href ? (
                              <a
                                className="overview-link"
                                data-testid="overview-link"
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                <LinkGlyph size={14} />
                                <span className="label">{l.label || l.url}</span>
                                <span className="url mono">{l.url}</span>
                              </a>
                            ) : (
                              <span className="overview-link inert" data-testid="overview-link">
                                <LinkGlyph size={14} />
                                <span className="label">{l.label || l.url}</span>
                                <span className="url mono">{l.url}</span>
                                <span className="inert-why">Not an https:// link, so it won&rsquo;t open</span>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </aside>
            )}

          </div>
        )}
      </div>
    </main>
  );
}
