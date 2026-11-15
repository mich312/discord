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
  isFavorite,
  toggleFavorite,
  matchesFilter,
  sortGames,
  makeGameId,
  normalizeGame,
} from '../lib/games.js';
import { nameHue } from '../lib/avatar.js';
import { Hash, Bell, LinkGlyph, Plus, X, ArrowRight, Gamepad, External, Copy, Check, Gear, Star, Server, More } from './icons.jsx';
import PopMenu from './PopMenu.jsx';
import { cx } from '../lib/cx.js';

// The circle's board: the next event, who is waiting to join, the people,
// the rooms, games when there are any, and the circle's pinned notes, lifts
// and links. Every synced word travels inside MLS; the relay reads none of it.

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
              placeholder="Event name"
              data-testid={i === 0 ? 'overview-event-title' : `overview-event-title-${i}`}
            />
            <input
              type="datetime-local"
              aria-label="Date and time"
              value={ev.at}
              onChange={(e) => setEvent(i, { at: e.target.value })}
              data-testid={i === 0 ? 'overview-event-at' : `overview-event-at-${i}`}
            />
          </div>
          <div className="overview-event-edit2">
            <input
              value={ev.note}
              onChange={(e) => setEvent(i, { note: e.target.value })}
              placeholder="Details (optional)"
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
        Add event
      </button>
      <label className="overview-field-label">About this circle</label>
      <textarea
        aria-label="About this circle"
        data-testid="overview-blurb-input"
        rows={4}
        value={blurb}
        onChange={(e) => setBlurb(e.target.value)}
        placeholder="What’s this circle for?"
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
        Add link
      </button>
      <div className="row overview-edit-actions">
        <button className="button primary" type="submit" data-testid="overview-save">
          Save
        </button>
        <button className="button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// The live band: shown while anyone in the circle is in a game, with who is
// in and one way to join them. Nothing when the circle is quiet.
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
            ? `${who[0] === 'you' ? 'You’re' : `${who[0]} is`} playing`
            : who.length <= 3
              ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are playing`
              : `${who.length} playing`}
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

// One game on the shelf. The cover carries the game's own hue; the main
// action follows its state: join when someone is in it, play when it is
// quiet, copy the address for a game server.
function GameCard({ game, players, canManage, rallied, onLaunch, onRally, onRemove, onFavorite }) {
  const [copied, setCopied] = useState(false);
  const [fav, setFav] = useState(() => isFavorite(game.id));
  const hue = nameHue(game.name);
  const host = gameHost(game);
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
  return (
    <li className={cx('game-card', live && 'live')} data-testid={`game-card-${game.id}`}>
      <div className="game-cover" style={{ background: `hsl(${hue} 38% 30%)` }}>
        <span className={cx('game-cover-mark', game.glyph && 'glyph')}>
          {game.glyph ?? game.name.slice(0, 1).toUpperCase()}
        </span>
        {live && (
          <span className="game-kind live" data-testid={`game-live-${game.id}`}>
            <span className="live-dot" aria-hidden="true" />
            Live
          </span>
        )}
      </div>
      <div className="game-body">
        <div className="game-name-row">
          <span className="game-name">{game.name}</span>
          {fav && (
            <span className="game-starred" role="img" aria-label="Starred">
              <Star size={14} filled />
            </span>
          )}
          {/* The name and Play are the card; star, new tab and remove are
              behind "…". */}
          <PopMenu
            className="game-more"
            label={`More for ${game.name}`}
            glyph={<More size={18} />}
            testid={`game-menu-${game.id}`}
            items={[
              {
                key: 'fav',
                label: fav ? 'Unstar' : 'Star',
                testid: `game-favorite-${game.id}`,
                onSelect: flipFav,
              },
              !isServer && {
                key: 'tab',
                label: 'Open in a new tab',
                testid: `game-newtab-${game.id}`,
                onSelect: () => window.open(game.url, '_blank', 'noopener,noreferrer'),
              },
              canManage && {
                key: 'remove',
                label: 'Remove from board',
                danger: true,
                testid: `game-remove-${game.id}`,
                onSelect: onRemove,
              },
            ].filter(Boolean)}
          />
        </div>
        {/* Where it runs, for a game that is not built in. */}
        {host && (
          <span className="game-host">
            {isServer ? <Server size={14} /> : <External size={14} />}
            {host}
          </span>
        )}
        {game.note && <span className="game-note">{game.note}</span>}
        {live ? (
          <span className="game-who">
            <span className="game-who-stack">
              {players.slice(0, 3).map((p) => (
                <Seal key={p} name={p} size={20} title={p} />
              ))}
            </span>
            {players.length === 1 ? `${players[0]} is playing` : `${players.length} playing`}
          </span>
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
            </>
          ) : (
            <>
              <button className="button" data-testid={`game-launch-${game.id}`} onClick={onLaunch}>
                <Gamepad size={14} />
                Play
              </button>
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
            {rallied ? 'Stop asking' : 'Ask to play'}
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
          placeholder={kind === 'server' ? 'Server address' : 'Web address'}
          aria-label={kind === 'server' ? 'Server address' : 'Web address'}
          data-testid="game-add-url"
        />
        <input
          className="game-add-glyph"
          value={glyph}
          onChange={(e) => setGlyph(e.target.value)}
          placeholder="♞"
          aria-label="Icon (one character)"
          data-testid="game-add-glyph"
        />
      </div>
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type" data-testid="game-add-kind">
        <option value="activity">Web game</option>
        <option value="server">Game server (separate app)</option>
      </select>
      <div className="row">
        <button className="button primary" type="submit" data-testid="game-add-save">
          Add
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
  digestKey,
  loadDigest,
  onSelectChannel,
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
  const [offering, setOffering] = useState(false);
  // The pin composer opens from a button, as the offer form does.
  const [pinning, setPinning] = useState(false);
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

  const whenOf = (at) =>
    new Date(at).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  // Lifts and spares draw only once someone has offered one; until then a
  // member gets a small button that opens the form in place.
  const showOffers = offers.length > 0 || (canSend && offering);
  const offerButton = canSend && !offering && (
    <button className="ghost offer-add" data-testid="overview-offer-add" onClick={() => setOffering(true)}>
      <Plus size={14} />
      Offer a lift
    </button>
  );
  // Pinned draws only when there is a note (or one being written). Until a
  // section exists its button sits in a plain row of board actions, so it
  // never reads as part of another section.
  const showPinned = notices.length > 0 || (canSend && pinning);
  const pinButton = canSend && !pinning && (
    <button className="ghost offer-add" data-testid="overview-notice-add" onClick={() => setPinning(true)}>
      <Plus size={14} />
      Pin a note
    </button>
  );
  const looseActions = [!showPinned && pinButton, !showOffers && offerButton].filter(Boolean);
  const hasSide =
    upcoming.length > 1 ||
    canSend ||
    notices.length > 0 ||
    offers.length > 0 ||
    (overview?.links?.length ?? 0) > 0;

  return (
    <main className="messages-pane overview-pane" data-testid="overview-pane">
      <header className="pane-head">
        <h2 className="room-name">Board</h2>
        {!editing && (
          <span className="pane-actions">
            {canManage && (
              <button className="button" data-testid="overview-edit" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {/* Not admin-gated: leaving the circle lives in that dialog. */}
            <button
              className="ghost"
              aria-label="Circle settings"
              title="Circle settings"
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
          // Two columns from 1081px: the circle on the left, its notes and
          // plans on the right. Narrower, the side column follows.
          <div className={cx('board', hasSide && 'with-side')}>
            <div className="board-main">
              {overview?.blurb ? (
                <p className="overview-blurb" data-testid="overview-blurb">
                  {overview.blurb}
                </p>
              ) : canManage ? (
                <button
                  className="ghost overview-blurb-add"
                  data-testid="overview-blurb-add"
                  onClick={() => setEditing(true)}
                >
                  <Plus size={14} />
                  Add a description
                </button>
              ) : null}

              {/* Who is waiting to get in. Draws only when somebody is — a
                  circle with nobody proposed should not carry an empty
                  governance block, and the roster below carries the propose
                  form. A proposal waiting on you is the one primary action
                  on the board. */}
              {proposals.length > 0 && (
                <section className="overview-section" data-testid="overview-proposals">
                  <h3 className="overline">Waiting to join</h3>
                  <ul className="overview-proposals">
                    {proposals.map((p) => {
                      const signed = standingSignatures(p, server.members).length;
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
                              <strong>{p.handle}</strong>
                            </span>
                            {/* §1.6: the count is the state, in words. */}
                            <span className="proposal-head">
                              Proposed by {p.by === me ? 'you' : p.by}. {signed} of {threshold} signed.
                              {p.objections.length > 0 &&
                                ` ${p.objections.length} objection${p.objections.length === 1 ? '' : 's'}.`}
                            </span>
                            <span className="proposal-meter" aria-hidden="true">
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
                            {d.last?.text ? `${d.last.sender}: ${d.last.text}` : topic ?? ''}
                          </span>
                          <span className="when">{d.last ? describeAgo(d.last.ts, now) : ''}</span>
                          <span className="go">
                            <ArrowRight size={14} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {bandGame && (
                <LiveBand
                  game={bandGame}
                  players={playingBy[bandGame.id] ?? []}
                  me={me}
                  onJoin={() => launchFromShelf(bandGame)}
                />
              )}

              {rallies.length > 0 && (
                <section className="hub-rallies" data-testid="hub-rallies">
                  <h3 className="overline">Want to play</h3>
                  <ul className="rally-list">
                    {rallies.map(({ game: g, who }) => (
                      <li className="rally-row" key={g.id} data-testid={`rally-${g.id}`}>
                        <span className="game-who-stack">
                          {who.slice(0, 3).map((p) => (
                            <Seal key={p} name={p} size={24} title={p} />
                          ))}
                        </span>
                        <span className="rally-text">
                          {ralliersLabel(who, me)} <strong>{g.name}</strong>
                        </span>
                        {g.kind === 'server' ? (
                          <span className="rally-host">{gameHost(g)}</span>
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

              {(games.length > 0 || canManage) && (
                <section className="overview-section">
                  <h3 className="overline">Games</h3>

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
                        No matches
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
                            <span className="add-card-title">Add game</span>
                          </button>
                        )}
                      </li>
                    )}
                  </ul>
                </section>
              )}
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

                {looseActions.length > 0 && <div className="board-side-actions">{looseActions}</div>}

                {showPinned && (
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
                    ) : null}
                    {canSend && pinning && (
                      <form
                        className="notice-composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = draft.trim();
                          if (!text) return;
                          setDraft('');
                          setPinning(false);
                          onAddNotice(text);
                        }}
                      >
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="Pin a note"
                          aria-label="Pin a note"
                          data-testid="overview-notice-input"
                        />
                        <button className="button" type="submit" data-testid="overview-notice-post">
                          Pin
                        </button>
                        <button
                          className="ghost"
                          type="button"
                          onClick={() => {
                            setPinning(false);
                            setDraft('');
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                    {pinButton}
                  </section>
                )}

                {showOffers && (
                  <section className="overview-section side-card" data-testid="overview-offers">
                    <h3 className="overline">Lifts and spares</h3>
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
                                  {left !== null && ` · ${o.seats - left}/${o.seats} seats`}
                                </span>
                              </div>
                              {left !== null && canSend && (
                                <button
                                  className={cx('button', 'offer-take', mine && 'pressed')}
                                  aria-pressed={mine}
                                  disabled={!mine && left === 0}
                                  data-testid={`overview-offer-take-${o.id}`}
                                  onClick={() => onTakeOffer(o.id, !mine)}
                                >
                                  {mine && <Check size={14} />}
                                  {mine ? 'You’re in' : left === 0 ? 'Full' : 'I’m in'}
                                </button>
                              )}
                              {canSend && canRemoveOffer(o, me, server.roles?.[me] === 'admin') && (
                                <button
                                  className="ghost notice-remove"
                                  aria-label="Remove"
                                  title="Remove"
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
                    {canSend && offering && (
                      <form
                        className="notice-composer offer-composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = offerDraft.trim();
                          if (!text) return;
                          setOfferDraft('');
                          setOfferSeats('');
                          setOffering(false);
                          onAddOffer(text, Number(offerSeats) || 0);
                        }}
                      >
                        <input
                          autoFocus
                          value={offerDraft}
                          onChange={(e) => setOfferDraft(e.target.value)}
                          placeholder="A lift or a spare"
                          aria-label="What you’re offering"
                          data-testid="overview-offer-input"
                        />
                        {/* §8.7: a real label, not a placeholder doing its job. */}
                        <label className="offer-seats">
                          <span className="sr-only">Seats (for a lift)</span>
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
                        <button
                          className="ghost"
                          type="button"
                          onClick={() => {
                            setOffering(false);
                            setOfferDraft('');
                            setOfferSeats('');
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                    {offerButton}
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
                                <span className="url">{l.url}</span>
                              </a>
                            ) : (
                              <span className="overview-link inert" data-testid="overview-link">
                                <LinkGlyph size={14} />
                                <span className="label">{l.label || l.url}</span>
                                <span className="url">{l.url}</span>
                                <span className="inert-why">Can&rsquo;t open this link</span>
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
