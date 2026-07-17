import React, { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { describeAgo, describeUntil, canRemoveNotice } from '../lib/overview.js';
import { gameHost, makeGameId, normalizeGame } from '../lib/games.js';
import { nameHue } from '../lib/avatar.js';
import { Hash, Wave, Lock, LinkGlyph, Plus, X, ArrowRight, Gamepad, External, Copy } from './icons.jsx';

// The circle's game hub: what you land on when you pick a circle. Not a
// brochure — a briefing, with the shelf front and center:
//   · what's coming up   — the next game night, with a live countdown
//   · what's on the shelf — the games this circle plays, living on their
//                          own servers; web games launch embedded here
//   · what did I miss    — per-room unread counts + the latest line,
//                          computed from this device's own store
//   · what should I know — a noticeboard the whole roster pins to
// Every word travels inside the MLS encryption; the relay reads none of it.
// What the relay CAN'T hide: connecting to a game shows that game's host
// your traffic — the shelf says so instead of pretending otherwise.

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

function EditForm({ overview, onSave, onCancel }) {
  const [blurb, setBlurb] = useState(overview?.blurb ?? '');
  const [links, setLinks] = useState(overview?.links ?? []);
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
          links,
          event:
            eventTitle.trim() && Number.isFinite(at)
              ? { title: eventTitle.trim(), at, note: eventNote.trim() }
              : null,
        });
      }}
    >
      <label className="overview-field-label">up next — the team&rsquo;s next date</label>
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
        <div className="overview-link-edit" key={i}>
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
        onClick={() => setLinks((ls) => [...ls, { label: '', url: '' }])}
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

// One game on the shelf. The cover carries the game's own hue (derived from
// its name, like a member's orb); actions differ by kind — web games launch
// embedded, server games hand over the address.
function GameCard({ game, canManage, onLaunch, onRemove }) {
  const [copied, setCopied] = useState(false);
  const hue = nameHue(game.name);
  const host = gameHost(game);
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(game.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard denied — the address is printed on the card regardless
    }
  };
  return (
    <li className="game-card" data-testid={`game-card-${game.id}`}>
      <div
        className="game-cover"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 40) % 360} 60% 40%))`,
        }}
      >
        <span className="game-cover-mark">{game.name.slice(0, 1).toUpperCase()}</span>
        <span className="game-kind">{game.kind === 'server' ? 'game server' : 'web game'}</span>
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
        <span className="game-name">{game.name}</span>
        <span className="game-host mono" title="this host sees its own traffic — never your chat">
          {host}
        </span>
        {game.note && <span className="game-note">{game.note}</span>}
        <div className="game-actions">
          {game.kind === 'server' ? (
            <button className="button primary" data-testid={`game-copy-${game.id}`} onClick={copyAddress}>
              <Copy size={13} />
              {copied ? 'copied' : 'copy address'}
            </button>
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
  return (
    <form
      className="game-add-form"
      data-testid="game-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        const game = normalizeGame({ id: makeGameId(), name, url, kind });
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
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={kind === 'server' ? 'address — mc.example.net:25565' : 'https:// where it lives'}
        data-testid="game-add-url"
      />
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
  onSave,
  onAddNotice,
  onRemoveNotice,
}) {
  const [editing, setEditing] = useState(false);
  const [addingGame, setAddingGame] = useState(false);
  const [draft, setDraft] = useState('');
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
  const event = overview?.event ?? null;
  const games = overview?.games ?? [];
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

  return (
    <main className="messages-pane overview-pane" data-testid="overview-pane">
      <header className="pane-head">
        <span className="room-name">
          <span className="glyph">
            <Gamepad size={14} />
          </span>
          game hub
        </span>
        <span className="sealed-note">
          sealed like everything else — the relay never learns what you play
        </span>
      </header>
      <div className="scroll overview-scroll">
        <section className="overview-hero">
          <Seal name={server.name} size={56} title={server.name} />
          <div className="overview-title">
            <h2 data-testid="overview-name">{server.name}</h2>
            <div className="overview-stats mono">
              <span>{server.members.length} member{server.members.length === 1 ? '' : 's'}</span>
              <span>·</span>
              <span data-testid="overview-unread-total">
                {unreadTotal > 0 ? `${unreadTotal} unread` : 'all caught up'}
              </span>
              <span>·</span>
              <span>epoch {String(server.epoch).padStart(2, '0')}</span>
            </div>
            {overview?.blurb && !editing && (
              <p className="overview-blurb" data-testid="overview-blurb">
                {overview.blurb}
              </p>
            )}
          </div>
          {canManage && !editing && (
            <button
              className="button overview-customize"
              data-testid="overview-edit"
              onClick={() => setEditing(true)}
            >
              customize
            </button>
          )}
        </section>

        {editing ? (
          <section className="overview-section">
            <span className="overline">customize</span>
            <EditForm
              overview={overview}
              onSave={(ov) => {
                setEditing(false);
                // The form edits the written half; the shelf rides along.
                onSave({ ...ov, games });
              }}
              onCancel={() => setEditing(false)}
            />
          </section>
        ) : (
          <>
            {event && (
              <section className="overview-upnext" data-testid="overview-event">
                <span className="wm-tag">
                  up next · <span data-testid="overview-countdown">{describeUntil(event.at, now)}</span>
                </span>
                <div className="upnext-body">
                  <strong className="upnext-title">{event.title}</strong>
                  <span className="upnext-when mono">
                    {new Date(event.at).toLocaleString([], {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {event.note && <p className="upnext-note">{event.note}</p>}
              </section>
            )}

            <section className="overview-section shelf-section">
              <span className="overline">
                <span>on the shelf</span>
                {games.length > 0 && <span className="idx">{games.length}</span>}
              </span>
              {games.length > 0 ? (
                <ul className="game-shelf" data-testid="game-shelf">
                  {games.map((g) => (
                    <GameCard
                      key={g.id}
                      game={g}
                      canManage={canManage}
                      onLaunch={() => onLaunchGame(g)}
                      onRemove={() => saveGames(games.filter((x) => x.id !== g.id))}
                    />
                  ))}
                </ul>
              ) : (
                !addingGame && (
                  <p className="muted overview-empty-note" data-testid="game-shelf-empty">
                    No games yet. The shelf holds pointers to games living on other servers —
                    web games launch right here with the room&rsquo;s chat and call beside them;
                    native servers get an address card.
                  </p>
                )
              )}
              {canManage &&
                (addingGame ? (
                  <AddGameForm
                    onAdd={(game) => {
                      setAddingGame(false);
                      saveGames([...games, game]);
                    }}
                    onCancel={() => setAddingGame(false)}
                  />
                ) : (
                  <button
                    className="ghost game-add"
                    data-testid="game-add"
                    onClick={() => setAddingGame(true)}
                  >
                    <Plus size={12} />
                    put a game on the shelf
                  </button>
                ))}
            </section>

            <section className="overview-section">
              <span className="overline">catch up</span>
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
                          {present.length ? `live now: ${present.join(', ')}` : 'voice table — empty'}
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
                  Nothing pinned. Anyone in the circle can pin a note here — schedules,
                  decisions, the thing nobody should have to scroll for.
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
                    ? 'Nothing here yet — use customize to set the next event, tell the circle what this place is for, and pin the links that matter.'
                    : 'The admins have not written anything here yet.'}
                </p>
              </section>
            )}
          </>
        )}

        <p className="fineprint muted overview-foot">
          Everything on this page — the event, the notes, the words — exists only inside
          the encryption. {server.members.length} device{server.members.length === 1 ? '' : 's'} can
          read it; the relay is not one of them.
        </p>
      </div>
    </main>
  );
}
