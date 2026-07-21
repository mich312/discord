import React, { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { describeAgo, describeUntil, canRemoveNotice } from '../lib/overview.js';
import {
  freshPresence,
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
import { Hash, Wave, LinkGlyph, Plus, X, ArrowRight, Gamepad, External, Copy, Check } from './icons.jsx';

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

// Which face of the hub you're on, remembered on this device — a view
// preference, never shared, so it needs no protocol.
const HUB_TAB_KEY = 'quorum-hub-tab';
function readTab() {
  try {
    return localStorage.getItem(HUB_TAB_KEY) === 'home' ? 'home' : 'play';
  } catch {
    return 'play';
  }
}
function writeTab(tab) {
  try {
    localStorage.setItem(HUB_TAB_KEY, tab);
  } catch {
    // private mode — the tab just resets to Play next time
  }
}

// datetime-local <-> ms, in the device's own timezone.
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const FILTER_LABEL = {
  all: 'all',
  live: 'live',
  favorites: 'starred',
  recent: 'recent',
  web: 'web',
  servers: 'servers',
};

let linkSeq = 0;

function EditForm({ overview, onSave, onCancel }) {
  const [blurb, setBlurb] = useState(overview?.blurb ?? '');
  // Each row gets a stable local id: with index keys, removing a middle
  // link makes React reuse the wrong controlled inputs for the rows below.
  const [links, setLinks] = useState(() =>
    (overview?.links ?? []).map((l) => ({ ...l, _id: ++linkSeq }))
  );
  const [eventTitle, setEventTitle] = useState(overview?.event?.title ?? '');
  const [eventAt, setEventAt] = useState(toLocalInput(overview?.event?.at));
  const [eventNote, setEventNote] = useState(overview?.event?.note ?? '');

  const setLink = (i, patch) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form
      className="overview-edit-form"
      data-testid="overview-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        const at = eventAt ? new Date(eventAt).getTime() : NaN;
        onSave({
          blurb: blurb.trim(),
          links: links.map(({ _id, ...l }) => l),
          event:
            eventTitle.trim() && Number.isFinite(at)
              ? { title: eventTitle.trim(), at, note: eventNote.trim() }
              : null,
        });
      }}
    >
      <label className="overview-field-label">up next — your circle&rsquo;s next event</label>
      <div className="overview-event-edit">
        <input
          value={eventTitle}
          onChange={(e) => setEventTitle(e.target.value)}
          placeholder="what's happening (leave empty for none)"
          data-testid="overview-event-title"
        />
        <input
          type="datetime-local"
          value={eventAt}
          onChange={(e) => setEventAt(e.target.value)}
          data-testid="overview-event-at"
        />
      </div>
      <input
        value={eventNote}
        onChange={(e) => setEventNote(e.target.value)}
        placeholder="one line of detail — where, what to bring… (optional)"
        data-testid="overview-event-note"
      />
      <label className="overview-field-label">about this circle</label>
      <textarea
        aria-label="about this circle"
        data-testid="overview-blurb-input"
        rows={4}
        value={blurb}
        onChange={(e) => setBlurb(e.target.value)}
        placeholder={'What is this circle for? House rules, cadence, where to start…'}
      />
      <label className="overview-field-label">pinned links</label>
      {links.map((l, i) => (
        <div className="overview-link-edit" key={l._id}>
          <input
            value={l.label}
            onChange={(e) => setLink(i, { label: e.target.value })}
            placeholder="label"
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
            title="remove link"
            onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost overview-add-link"
        data-testid="overview-add-link"
        onClick={() => setLinks((ls) => [...ls, { label: '', url: '', _id: ++linkSeq }])}
      >
        <Plus size={12} />
        add a link
      </button>
      <div className="row overview-edit-actions">
        <button className="button primary" type="submit" data-testid="overview-save">
          save changes
        </button>
        <button className="button" type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
      <p className="fineprint muted">
        Everyone in the roster sees this page. Links open only if they start with
        https:// — everything else stays plain text.
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
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 40) % 360} 60% 40%))`,
        }}
        aria-hidden="true"
      >
        <span className={game.glyph ? 'game-cover-mark glyph' : 'game-cover-mark'}>
          {game.glyph ?? game.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
      <div className="hub-band-body">
        <span className="overline live hub-band-tag">
          <Wave size={11} /> live in this circle
        </span>
        <strong className="hub-band-title">{game.name}</strong>
        <span className="hub-band-who">
          <span className="game-who-stack">
            {players.slice(0, 4).map((p) => (
              <Seal key={p} name={p} size={20} title={p} />
            ))}
          </span>
          {players.length === 1
            ? `${players[0] === me ? 'you are' : `${players[0]} is`} playing`
            : `${players.length} playing right now`}
        </span>
      </div>
      {isServer ? (
        <button className="button" data-testid="hub-band-copy" onClick={copyAddress}>
          <Copy size={13} />
          {copied ? 'copied' : 'copy address'}
        </button>
      ) : (
        <button className="button live hub-band-join" data-testid="hub-band-join" onClick={onJoin}>
          <Gamepad size={13} />
          join{players.length > 0 ? ` · ${players.length} in` : ''}
        </button>
      )}
    </section>
  );
}

// One game on the shelf. The cover carries the game's own hue (derived from
// its name, like a member's orb); the primary action reads the game's state —
// join when the circle's already in it, launch when it's quiet, copy for a
// native server — so one glance tells you the next move.
function GameCard({ game, players, canManage, onLaunch, onRemove, onFavorite }) {
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
    <li className={live ? 'game-card live' : 'game-card'} data-testid={`game-card-${game.id}`}>
      <div
        className="game-cover"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 40) % 360} 60% 40%))`,
        }}
      >
        <span className="game-grain" aria-hidden="true" />
        <span className={game.glyph ? 'game-cover-mark glyph' : 'game-cover-mark'}>
          {game.glyph ?? game.name.slice(0, 1).toUpperCase()}
        </span>
        {live ? (
          <span className="game-kind live" data-testid={`game-live-${game.id}`}>
            live · {players.slice(0, 2).join(' & ')}
            {players.length > 2 ? ` +${players.length - 2}` : ''}
          </span>
        ) : (
          <span className="game-kind">{isServer ? 'game server' : 'web game'}</span>
        )}
        {canManage && (
          <button
            className="ghost game-remove"
            title="take off the shelf"
            data-testid={`game-remove-${game.id}`}
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="game-body">
        <div className="game-name-row">
          <span className="game-name">{game.name}</span>
          <button
            className={fav ? 'game-fav on' : 'game-fav'}
            title={fav ? 'unstar — remove from your favorites' : 'star — pin to the front for you'}
            aria-pressed={fav}
            data-testid={`game-favorite-${game.id}`}
            onClick={flipFav}
          >
            {fav ? '★' : '☆'}
          </button>
        </div>
        <span className="game-host mono" title="this host sees its own traffic — never your chat">
          {isServer ? '⛭' : '◈'} {host}
        </span>
        {game.note && <span className="game-note">{game.note}</span>}
        {live ? (
          <span className="game-who">
            <span className="game-who-stack">
              {players.slice(0, 3).map((p) => (
                <Seal key={p} name={p} size={20} title={p} />
              ))}
            </span>
            {players.length === 1 ? `${players[0]} is in` : `${players.length} playing right now`}
          </span>
        ) : idleNote ? (
          <span className="game-who muted">{idleNote}</span>
        ) : null}
        <div className="game-actions">
          {isServer ? (
            <button className="button primary" data-testid={`game-copy-${game.id}`} onClick={copyAddress}>
              <Copy size={13} />
              {copied ? 'copied' : 'copy address'}
            </button>
          ) : live ? (
            <>
              <button
                className="button live"
                data-testid={`game-join-${game.id}`}
                onClick={onLaunch}
              >
                <Gamepad size={13} />
                join{players.length > 0 ? ` · ${players.length} in` : ''}
              </button>
              <a
                className="button"
                title="open in its own tab"
                href={game.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <External size={13} />
              </a>
            </>
          ) : (
            <>
              <button className="button primary" data-testid={`game-launch-${game.id}`} onClick={onLaunch}>
                <Gamepad size={13} />
                launch
              </button>
              <a
                className="button"
                title="open in its own tab"
                href={game.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <External size={13} />
              </a>
            </>
          )}
        </div>
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
        placeholder="game name"
        data-testid="game-add-name"
      />
      <div className="game-add-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={kind === 'server' ? 'address — mc.example.net:25565' : 'https:// where it lives'}
          data-testid="game-add-url"
        />
        <input
          className="game-add-glyph"
          value={glyph}
          onChange={(e) => setGlyph(e.target.value)}
          placeholder="♞"
          title="cover mark — one emoji or glyph (optional)"
          data-testid="game-add-glyph"
        />
      </div>
      <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="game-add-kind">
        <option value="activity">web game — plays embedded here</option>
        <option value="server">game server — join with its own client</option>
      </select>
      <div className="row">
        <button className="button primary" type="submit" data-testid="game-add-save">
          put it on the shelf
        </button>
        <button className="button" type="button" onClick={onCancel}>
          cancel
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
  onRsvp,
  onSave,
  onAddNotice,
  onRemoveNotice,
}) {
  const [tab, setTab] = useState(readTab);
  const [editing, setEditing] = useState(false);
  const [addingGame, setAddingGame] = useState(false);
  const [filter, setFilter] = useState('all');
  // Bumped when a card's star flips, so the shelf re-sorts live-first /
  // starred / recent without the parent tracking each card's state.
  const [favTick, setFavTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [digest, setDigest] = useState([]);
  // Countdown and "x min ago" labels drift; tick them along while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const goTab = (next) => {
    setTab(next);
    writeTab(next);
  };

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
  const event = overview?.event ?? null;
  const games = overview?.games ?? [];
  // Live claims: game id -> member handles playing it right now.
  const playingBy = {};
  for (const [handle, entry] of Object.entries(server.presence ?? {})) {
    const g = freshPresence(entry, now);
    if (g) (playingBy[g.id] ??= []).push(handle);
  }
  const liveGames = games.filter((g) => (playingBy[g.id] ?? []).length > 0);
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

  // Who said "I'm in" for THIS event (answers are keyed to its timestamp).
  const going = event
    ? Object.entries(server.rsvps ?? {})
        .filter(([, v]) => v.at === event.at)
        .map(([handle]) => handle)
    : [];
  const iAmIn = going.includes(me);
  const saveGames = (next) => onSave({ ...(overview ?? {}), games: next });
  const notices = server.notices ?? [];
  const voiceRooms = server.voiceChannels ?? ['lounge'];
  const byChannel = Object.fromEntries(digest.map((d) => [d.channel, d]));
  const unreadTotal = digest.reduce((n, d) => n + d.unread, 0);
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

  return (
    <main className="messages-pane overview-pane" data-testid="overview-pane">
      <header className="pane-head">
        <span className="room-name">
          <span className="glyph">
            <Gamepad size={14} />
          </span>
          game hub
        </span>
        {!editing && (
          <span className="hub-tabs" role="tablist" aria-label="game hub view">
            <button
              className={tab === 'play' ? 'hub-tab on' : 'hub-tab'}
              role="tab"
              aria-selected={tab === 'play'}
              data-testid="overview-tab-play"
              onClick={() => goTab('play')}
            >
              play
            </button>
            <button
              className={tab === 'home' ? 'hub-tab on' : 'hub-tab'}
              role="tab"
              aria-selected={tab === 'home'}
              data-testid="overview-tab-home"
              onClick={() => goTab('home')}
            >
              home
            </button>
          </span>
        )}
        {canManage && !editing && (
          <span className="pane-actions">
            {tab === 'home' && (
              <button className="button" data-testid="overview-edit" onClick={() => setEditing(true)}>
                customize
              </button>
            )}
            {tab === 'play' && !addingGame && (
              <button className="button" data-testid="game-add" onClick={() => setAddingGame(true)}>
                <Plus size={13} />
                register a game
              </button>
            )}
          </span>
        )}
      </header>
      <div className="scroll overview-scroll">
        {editing ? (
          <section className="overview-section">
            <span className="overline">customize</span>
            <EditForm
              // Remount when a remote edit lands while the form is open:
              // saving a form seeded from the old overview would silently
              // overwrite the other admin's newer changes.
              key={JSON.stringify([overview?.blurb, overview?.links, overview?.event])}
              overview={overview}
              onSave={(ov) => {
                setEditing(false);
                // The form edits the written half; the shelf rides along.
                onSave({ ...ov, games });
              }}
              onCancel={() => setEditing(false)}
            />
          </section>
        ) : tab === 'play' ? (
          <>
            {bandGame ? (
              <LiveBand
                game={bandGame}
                players={playingBy[bandGame.id] ?? []}
                me={me}
                onJoin={() => launchFromShelf(bandGame)}
              />
            ) : games.length > 0 ? (
              <p className="hub-nudge" data-testid="hub-quiet">
                No one&rsquo;s playing right now — launch one below to get a game going.
              </p>
            ) : null}

            <section className="overview-section shelf-section">
              <span className="overline shelf-overline">
                <span>on the shelf</span>
                {games.length > 0 && (
                  <span className="shelf-meta">
                    {games.length} game{games.length === 1 ? '' : 's'}
                    {liveGames.length > 0 && <span className="shelf-live"> · {liveGames.length} live</span>}
                  </span>
                )}
              </span>

              {showFilters && (
                <div className="shelf-filters" role="group" aria-label="filter the shelf">
                  {filterChips.map((f) => (
                    <button
                      key={f}
                      className={filter === f ? 'fchip on' : 'fchip'}
                      data-testid={`game-filter-${f}`}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f === 'live' && <span className="fchip-dot" aria-hidden="true" />}
                      {f === 'favorites' && <span aria-hidden="true">★ </span>}
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
                      onLaunch={() => launchFromShelf(g)}
                      onRemove={() => saveGames(games.filter((x) => x.id !== g.id))}
                      onFavorite={() => setFavTick((n) => n + 1)}
                    />
                  ))}
                  {games.length > 0 && shownGames.length === 0 && (
                    <li className="shelf-empty-filter muted" data-testid="game-filter-empty">
                      Nothing here under “{FILTER_LABEL[filter]}”.
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
                          <span className="add-card-title">Register a game</span>
                          <span className="add-card-sub">
                            a URL is enough — it shows up here for the whole circle
                          </span>
                        </button>
                      )}
                    </li>
                  )}
                </ul>
              ) : (
                <p className="muted overview-empty-note" data-testid="game-shelf-empty">
                  No games yet. Add one and it shows up here for the whole circle.
                </p>
              )}
              <p className="shelf-honesty muted" data-testid="shelf-honesty">
                Games live on their own servers — each card names where. That host sees your
                connection, never your chat.
              </p>
            </section>

            <p className="hub-jump muted">
              Your circle&rsquo;s briefing — next event, room catch-up, noticeboard —{' '}
              <button className="linklike" data-testid="hub-jump-home" onClick={() => goTab('home')}>
                lives under Home →
              </button>
            </p>
          </>
        ) : (
          <>
            <section className="hub-about">
              {overview?.blurb && (
                <p className="overview-blurb" data-testid="overview-blurb">
                  {overview.blurb}
                </p>
              )}
              <div className="overview-stats mono">
                <span>{server.members.length} member{server.members.length === 1 ? '' : 's'}</span>
                <span>·</span>
                <span data-testid="overview-unread-total">
                  {unreadTotal > 0 ? `${unreadTotal} unread` : 'all caught up'}
                </span>
              </div>
            </section>

            {event && (
              <section className="overview-upnext hub-hero" data-testid="overview-event">
                <div className="hub-hero-body">
                  <span className="wm-tag">
                    up next · <span data-testid="overview-countdown">{describeUntil(event.at, now)}</span>
                  </span>
                  <strong className="upnext-title hub-hero-title">{event.title}</strong>
                  <p className="upnext-note">
                    <span className="upnext-when mono">
                      {new Date(event.at).toLocaleString([], {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {event.note && <> — {event.note}</>}
                  </p>
                  {canSend && (
                    <div className="hub-rsvp">
                      <button
                        className={iAmIn ? 'button live' : 'button primary'}
                        data-testid="rsvp-toggle"
                        onClick={() => onRsvp(event.at, !iAmIn)}
                      >
                        {iAmIn ? <Check size={13} /> : null}
                        {iAmIn ? ' you’re in' : 'I’m in'}
                      </button>
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
                    </div>
                  )}
                </div>
                {(() => {
                  const d = event.at - now;
                  const [n, u] =
                    d <= 0
                      ? ['now', 'happening']
                      : d < 2 * 3600e3
                        ? [Math.max(1, Math.round(d / 60e3)), 'min to go']
                        : d < 48 * 3600e3
                          ? [Math.round(d / 3600e3), 'hours to go']
                          : [Math.round(d / 86400e3), 'days to go'];
                  return (
                    <div className="hub-count" aria-hidden="true">
                      <span className="n">{n}</span>
                      <span className="u">{u}</span>
                    </div>
                  );
                })()}
              </section>
            )}

            <section className="overview-section">
              <span className="overline">while you were out</span>
              <ul className="overview-rooms">
                {rooms.map((ch) => {
                  const d = byChannel[ch] ?? { unread: 0, last: null };
                  const topic = server.chanMeta?.[ch]?.topic;
                  return (
                    <li key={ch}>
                      <button
                        className={d.unread ? 'overview-room has-unread' : 'overview-room'}
                        data-testid={`overview-room-${ch}`}
                        onClick={() => onSelectChannel(ch)}
                      >
                        <span className="glyph">
                          <Hash size={13} />
                        </span>
                        <span className="room">{ch}</span>
                        {d.unread > 0 && (
                          <span className="unread-badge" data-testid={`overview-unread-${ch}`}>
                            {d.unread}
                          </span>
                        )}
                        <span className="last">
                          {d.last
                            ? `${d.last.sender}: ${d.last.text}`
                            : topic ?? 'nothing here yet'}
                        </span>
                        <span className="when mono">
                          {d.last ? describeAgo(d.last.ts, now) : ''}
                        </span>
                        <span className="go">
                          <ArrowRight size={12} />
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
                        className={present.length ? 'overview-room voice live' : 'overview-room voice'}
                        data-testid={`overview-voice-${ch}`}
                        onClick={() => onVoiceJoin(ch)}
                        title={`join "${ch}"`}
                      >
                        <span className="glyph">
                          <Wave size={13} />
                        </span>
                        <span className="room">{ch}</span>
                        <span className="last">
                          {present.length ? `live now: ${present.join(', ')}` : 'voice room — empty'}
                        </span>
                        <span className="go mono">join</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="overview-section">
              <span className="overline">noticeboard</span>
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
                    placeholder="pin a note for the team…"
                    data-testid="overview-notice-input"
                  />
                  <button className="button" type="submit" data-testid="overview-notice-post">
                    pin
                  </button>
                </form>
              )}
              {notices.length ? (
                <ul className="overview-notices">
                  {notices.map((n) => (
                    <li className="notice" key={n.id} data-testid="overview-notice">
                      <Seal name={n.author} size={22} title={n.author} />
                      <div className="notice-body">
                        <span className="notice-head mono">
                          {n.author} · {describeAgo(n.ts, now)}
                        </span>
                        <span className="notice-text">{n.text}</span>
                      </div>
                      {canSend && canRemoveNotice(n, me, server.roles) && (
                        <button
                          className="ghost notice-remove"
                          title="unpin"
                          data-testid={`overview-notice-remove-${n.id}`}
                          onClick={() => onRemoveNotice(n.id)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted overview-empty-note" data-testid="overview-notices-empty">
                  Nothing pinned yet. Pin notes the whole circle should see.
                </p>
              )}
            </section>

            {(overview?.links?.length ?? 0) > 0 && (
              <section className="overview-section">
                <span className="overline">pinned links</span>
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
                            <LinkGlyph size={13} />
                            <span className="label">{l.label || l.url}</span>
                            <span className="url mono">{l.url}</span>
                          </a>
                        ) : (
                          <span
                            className="overview-link inert"
                            data-testid="overview-link"
                            title="not an https:// link — shown, never opened"
                          >
                            <LinkGlyph size={13} />
                            <span className="label">{l.label || l.url}</span>
                            <span className="url mono">{l.url}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {!overview?.blurb && (
              <section className="overview-section">
                <span className="overline">about</span>
                <p className="overview-blurb placeholder muted" data-testid="overview-blurb-empty">
                  {canManage
                    ? 'Nothing here yet — hit Customize to set an event, describe this circle, and pin links.'
                    : 'The admins have not written anything here yet.'}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
