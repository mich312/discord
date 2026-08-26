import React, { useEffect, useMemo, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import { describeRetention, freshTyping } from '../lib/controller.js';
import { circlePresence } from '../lib/presence.js';
import { meshFull, meshFullMessage } from '../lib/voice.js';
import { nameHue } from '../lib/avatar.js';
import { fold, dayLabel } from '../lib/fold.js';
import { AlertTriangle, Lock, Hash, Paperclip, Clock, Archive, Wave, Gamepad, Check, Plus, Reply, Pencil, Trash, X } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The reaction palette: small on purpose. Reactions ride MLS like any
// message and live on the folded message; each is its own log entry.
const EMOJI = ['👍', '🔥', '😂', '❤️', '💀', '😮'];

// Display-only reaction pills under a line. The add trigger lives in the
// hover toolbar (MessageActions), not here.
function ReactionPills({ message, me, onReact }) {
  const reacts = message.reacts ?? {};
  const entries = Object.entries(reacts).filter(([, who]) => who.length);
  if (!entries.length) return null;
  const target = { sender: message.sender, ts: message.ts };
  return (
    <span className="reacts">
      {entries.map(([emo, who]) => (
        <button
          key={emo}
          className={cx('react', who.includes(me) && 'on')}
          title={who.join(', ')}
          data-testid={`react-${emo}`}
          onClick={() => onReact?.(target, emo)}
        >
          {emo} {who.length}
        </button>
      ))}
    </span>
  );
}

// The floating hover toolbar at a line's top-right: react (with picker),
// reply, and — on your own live text lines — edit and delete. Delete is a
// two-tap confirm so a stray click can't tombstone a message.
function MessageActions({ message, me, onReact, onReply, onEdit, onDelete }) {
  const [picking, setPicking] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);
  const mine = message.sender === me;
  const target = { sender: message.sender, ts: message.ts };
  const canReact = !!onReact;
  const canReply = !!onReply;
  const canEdit = mine && onEdit && message.text != null && !message.file && !message.game;
  const canDelete = mine && !!onDelete;
  if (!canReact && !canReply && !canEdit && !canDelete) return null;
  return (
    <span className="msg-actions" data-testid="msg-actions">
      {canReact && (
        <span className="react-add-wrap">
          <button
            className="msg-act"
            title="add reaction"
            data-testid="react-add"
            onClick={() => setPicking((v) => !v)}
          >
            <Plus size={13} />
          </button>
          {picking && (
            <span className="react-picker" data-testid="react-picker">
              {EMOJI.map((emo) => (
                <button
                  key={emo}
                  className="react-pick"
                  onClick={() => {
                    setPicking(false);
                    onReact(target, emo);
                  }}
                >
                  {emo}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {canReply && (
        <button className="msg-act" title="reply" data-testid="msg-reply" onClick={() => onReply(message)}>
          <Reply size={13} />
        </button>
      )}
      {canEdit && (
        <button className="msg-act" title="edit" data-testid="msg-edit" onClick={() => onEdit(message)}>
          <Pencil size={13} />
        </button>
      )}
      {canDelete &&
        (confirmDel ? (
          <button
            className="msg-act danger"
            title="click again to delete for everyone — the entry is removed from the relay, but not from devices that already read it"
            data-testid="msg-del-confirm"
            onClick={() => {
              setConfirmDel(false);
              onDelete(message);
            }}
          >
            delete?
          </button>
        ) : (
          <button
            className="msg-act"
            title="delete"
            data-testid="msg-del"
            onClick={() => setConfirmDel(true)}
          >
            <Trash size={13} />
          </button>
        ))}
    </span>
  );
}

// Render message text with @mentions of current members highlighted; the
// reader's own handle glows brighter. Matching is done at render time
// against the live roster, so nothing about mentions rides the wire.
function MessageText({ text, members, me }) {
  const nodes = useMemo(() => {
    const roster = new Set(members ?? []);
    const out = [];
    // @handle where handle is one of the current members (case-insensitive).
    const re = /@([a-zA-Z0-9_.-]{1,64})/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) != null) {
      const handle = [...roster].find((h) => h.toLowerCase() === m[1].toLowerCase());
      if (!handle) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(
        <span
          key={`${m.index}`}
          className={cx('mention', handle === me && 'self')}
          data-testid="mention"
        >
          @{handle}
        </span>
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text, members, me]);
  return <span className="text">{nodes}</span>;
}

// A message's device-local identity, used to anchor a reply's "jump to
// original" and to tell whether the quoted line is even present here — a
// joiner with no scrollback often won't have it, and the quote must still
// read on its own.
const midOf = (m) => `${m.sender}:${m.ts}`;

// The quoted snapshot a reply carries. Built at reply time from whatever the
// answered line was — text, or a short stand-in for a file / game card — and
// bounded, because it travels inside every reply and renders as plain text.
function quoteOf(m) {
  const text = m.file
    ? `📎 ${m.file.name}`
    : m.game
      ? `opened ${m.game?.name ?? 'a game'}`
      : (m.text ?? '');
  return { sender: m.sender, ts: m.ts, text: text.slice(0, 140) };
}

// The quote block shown above a reply. Clickable to scroll to the original
// when this device has it; inert (but still readable) when it doesn't.
function QuotedReply({ reply, me, onJump }) {
  const preview = reply.text?.trim() || 'attachment';
  return (
    <button
      type="button"
      className={cx('reply-quote', !(onJump) && 'orphan')}
      data-testid="reply-quote"
      onClick={onJump ?? undefined}
      disabled={!onJump}
      title={onJump ? 'jump to the quoted message' : 'the quoted message isn’t on this device'}
    >
      <Reply size={11} />
      <span className="rq-who">{reply.sender === me ? 'you' : reply.sender}</span>
      <span className="rq-text">{preview}</span>
    </button>
  );
}

// "alice is typing…" — driven entirely by the ephemeral typing map, filtered
// to this channel and reader-expired. A 1s ticker lets a signal fade on its
// own when the composer falls silent, without any "stopped typing" event.
function TypingLine({ typing, channel, me }) {
  const [now, setNow] = useState(() => Date.now());
  const present = Object.entries(typing ?? {}).filter(
    ([who, e]) => who !== me && e?.channel === channel
  );
  useEffect(() => {
    if (!present.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [present.length]);
  const names = present
    .filter(([, e]) => freshTyping(e, now))
    .map(([who]) => who)
    .sort();
  const label =
    names.length === 0
      ? null
      : names.length === 1
        ? `${names[0]} is typing`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing`
          : `${names[0]}, ${names[1]} and ${names.length - 2} more are typing`;
  return (
    <div className="typing-line" data-testid="typing-line" aria-live="polite">
      {label && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {label}
        </>
      )}
    </div>
  );
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Fold the flat message list into day dividers, system chips, and groups of
// consecutive lines from one sender within a five-minute window.
function Attachment({ file, fetchFile }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const isImage = (file.mime ?? '').startsWith('image/');

  // Images decrypt eagerly and render inline; other files decrypt on click.
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let objectUrl;
    fetchFile(file)
      .then((bytes) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
        setUrl(objectUrl);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.blob]);

  if (isImage) {
    if (error) return <span className="muted">attachment: {error}</span>;
    if (!url)
      return (
        <span
          className="attachment-skeleton"
          data-testid="attachment-skeleton"
          role="img"
          aria-label={`decrypting ${file.name}`}
          title={`decrypting ${file.name}…`}
        />
      );
    return <img className="attachment-img" src={url} alt={file.name} data-testid="attachment-img" />;
  }
  return (
    <button
      className="attachment-file"
      data-testid="attachment-file"
      title={`${file.name} — decrypt & download`}
      onClick={async () => {
        try {
          const bytes = await fetchFile(file);
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = file.name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        } catch (e) {
          setError(e.message);
        }
      }}
    >
      <Paperclip size={14} />
      {file.name}
      <span className="size">{Math.max(1, Math.round(file.size / 1024))} KB{error ? ` — ${error}` : ''}</span>
    </button>
  );
}

// "bob opened Hex Gambit" as a first-class message. The Join button
// resolves the reference against the circle's shelf — if the game was
// taken off (or never existed), the card stays but the button dims.
function GameInvite({ game, sender, me, shelf, onLaunchGame }) {
  const resolved = shelf.find((g) => g.id === game.id) ?? null;
  const hue = nameHue(game.name);
  return (
    <div className="game-invite" data-testid="game-invite">
      <div
        className="gi-art"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 40) % 360} 60% 40%))`,
        }}
      >
        <Gamepad size={22} />
      </div>
      <div className="gi-body">
        <span className="gi-title">
          {sender === me ? 'you' : sender} opened {game.name}
        </span>
        <span className="gi-sub mono">
          {resolved
            ? resolved.kind === 'server'
              ? resolved.url
              : 'on the shelf — plays right here'
            : 'no longer on the shelf'}
        </span>
        <span className="gi-actions">
          {resolved && resolved.kind === 'activity' ? (
            <button
              className="button live"
              data-testid="game-invite-join"
              onClick={() => onLaunchGame(resolved)}
            >
              join game
            </button>
          ) : resolved ? (
            <button
              className="button"
              data-testid="game-invite-copy"
              onClick={() => navigator.clipboard?.writeText(resolved.url).catch(() => {})}
            >
              copy address
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export default function Messages({
  server,
  channel,
  me,
  messages,
  onSend,
  onSendFile,
  fetchFile,
  voice,
  onVoiceJoin,
  onOpenStage,
  // Where the roster lives now that it is not a column beside this one.
  onOpenBoard,
  onLaunchGame,
  onReact,
  onRetry,
  onType,
  onEdit,
  onDelete,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  // The line being edited (a message), or null. Editing takes over the
  // composer, so it and a pending reply are mutually exclusive.
  const [editing, setEditing] = useState(null);
  // Touch has no hover, so the action toolbar needs something to reveal it.
  // Tapping a line selects it; tapping it again (or any other line) puts it
  // away. Pointer devices never read this — the hover rule already covers
  // them, and the class carries no styling outside `@media (hover: none)`.
  const [acting, setActing] = useState(null);
  const inputRef = useRef(null);
  const scroller = useRef(null);
  const attachRef = useRef(null);
  // Incoming messages were never announced: a screen-reader user in a room
  // got no signal that anything had arrived, which is the core function of
  // the product. The whole transcript cannot be a live region — it would
  // re-read on every render and recite the chrome with it — so one small
  // region carries the newest line and nothing else.
  const [announce, setAnnounce] = useState('');
  const lastSeen = useRef(null);
  // Which lines this device actually holds — a reply's "jump to original"
  // only lights up when the quoted line is one of them.
  const present = useMemo(() => new Set(messages.map(midOf)), [messages]);
  // A reply or edit pins to one message; if that message drops out from
  // under us (retention, channel switch, a delete), quietly let it go.
  useEffect(() => {
    if (replyTo && !present.has(`${replyTo.sender}:${replyTo.ts}`)) setReplyTo(null);
    if (editing && !present.has(`${editing.sender}:${editing.ts}`)) setEditing(null);
  }, [present, replyTo, editing]);
  const startReply = (m) => {
    setEditing(null);
    setReplyTo(quoteOf(m));
    inputRef.current?.focus();
  };
  const startEdit = (m) => {
    setReplyTo(null);
    setEditing(m);
    setDraft(m.text ?? '');
    inputRef.current?.focus();
  };
  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };
  const jumpTo = (id) => {
    const el = scroller.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  };
  // Stay pinned to the newest line only while the user is already at (or
  // near) the bottom — a reaction or backfill elsewhere must not yank
  // someone out of their scrollback.
  const pinned = useRef(true);
  const folded = useMemo(() => fold(messages), [messages]);
  const hasLines = useMemo(() => messages.some((m) => !m.system), [messages]);
  const members = server.members.length;
  const meta = server.chanMeta?.[channel] ?? {};
  const shelf = server.overview?.games ?? [];
  // The header's call affordance: join the busiest voice room (or the
  // first one), or hop back to the stage if we're already in a call here.
  const voiceRooms = server.voiceChannels ?? ['lounge'];
  const inCallHere = voice?.active?.server === server.id;
  const liveRoom =
    voiceRooms
      .map((r) => ({ r, n: voice?.presence?.[`${server.id}/${r}`]?.length ?? 0 }))
      .sort((a, b) => b.n - a.n)[0] ?? null;

  // Who is here, and whose key nobody has checked — the two facts the roster
  // column carried that a room genuinely needs on screen. Same definitions as
  // the roster itself, so the header and the board cannot disagree.
  const liveHere = circlePresence(server, voice).live;
  const unchecked = server.members.filter(
    (m) => m !== me && !(server.verified ?? []).includes(m) && !server.mismatched?.[m]
  ).length;

  // Switching room or circle resets the watermark, so the backlog that
  // renders next is not "new" and must not be read out.
  useEffect(() => {
    lastSeen.current = null;
    setAnnounce('');
  }, [channel, server.id]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const id = `${last.sender ?? 'system'}:${last.ts}`;
    // First pass after a reset is the existing history, not an arrival.
    if (lastSeen.current === null) {
      lastSeen.current = id;
      return;
    }
    if (lastSeen.current === id) return;
    lastSeen.current = id;
    // Your own sends are not news, and you already know you sent them.
    if (last.system || last.sender === me) return;
    const body = last.deleted
      ? 'deleted a message'
      : last.file
        ? `sent a file, ${last.file.name}`
        : last.game
          ? `opened ${last.game.name ?? 'a game'}`
          : (last.text ?? '');
    // Only the newest line: a burst would otherwise queue up and read for
    // longer than it takes the next one to arrive.
    setAnnounce(`${last.sender}: ${body}`);
  }, [messages, me]);

  useEffect(() => {
    if (pinned.current) scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  return (
    <main className="messages-pane" id="messages-pane" tabIndex={-1}>
      <span className="sr-only" role="log" aria-live="polite" aria-atomic="true">
        {announce}
      </span>
      <header className="pane-head">
        {/* A hash, not a padlock. The padlock here was the third encryption
            signal on one surface — the kept-history note is beside it and the
            composer footer states the claim in words — and §10.11 asks for
            one per surface. The glyph's job is "this is a text room", which
            is what the marker and the strip use it for too. */}
        <h2 className="room-name">
          <span className="glyph">
            <Hash size={13} />
          </span>
          {channel}
        </h2>
        {meta.topic && (
          <span className="room-topic" data-testid="channel-topic-display" title={meta.topic}>
            {meta.topic}
          </span>
        )}
        {/* What the roster column used to say from here, said in a line. The
            column was the densest thing on the screen and it sat beside the
            conversation, so it cost a fifth of the width to answer a question
            that fits in five words. The people themselves are on the board,
            which is where this goes. */}
        <button className="room-here" data-testid="room-here" onClick={onOpenBoard}>
          <span className={cx('room-here-n', liveHere.length && 'live')}>
            {liveHere.length} of {server.members.length}
          </span>{' '}
          here
        </button>
        {unchecked > 0 && (
          // §10.5 — a warning is the control that resolves it. It is not a
          // tooltip and not a colour: it says the number, and tapping it goes
          // to the people whose keys nobody has compared. §9.5 is why it did
          // not simply leave with the column it used to live in.
          <button
            className="room-unchecked"
            data-testid="room-unchecked"
            title="nobody on this device has compared these keys yet"
            onClick={onOpenBoard}
          >
            <AlertTriangle size={13} />
            {unchecked} unchecked
          </button>
        )}
        {/* The forward-secrecy trade, stated wherever it applies rather than
            once in a system chip that scrolls out of view. Every room keeps
            its history now, so this is not a per-room exception any more —
            but it is still the cost, and it is only clearly labeled if it is
            on screen where the messages are. */}
        <span className="sealed-note">
          <span
            className="kept-note"
            data-testid="kept-history-note"
            title="This room's messages are stored on the relay, encrypted under a key everyone in the circle holds. Anyone added later can read its past, so messages here are not forward-secret."
          >
            <Archive size={11} /> kept for the circle — anyone added later can read back
          </span>
          {meta.retention ? (
            <>
              <span className="note-sep">·</span>
              <span className="retention-note" title="auto-delete is on for this room">
                <Clock size={11} /> auto-deletes {describeRetention(meta.retention)} after sending
              </span>
            </>
          ) : null}
        </span>
        {inCallHere && onOpenStage ? (
          <button className="button pane-call live" data-testid="pane-open-call" onClick={onOpenStage}>
            <Wave size={13} />
            open call
          </button>
        ) : liveRoom && onVoiceJoin ? (
          <button
            className={cx('button pane-call', liveRoom.n && 'live')}
            data-testid="pane-join-voice"
            // Say "full" before the click rather than after. The join is
            // refused either way, but a disabled button with a reason is not
            // the same experience as a toast that looks like a failure.
            disabled={meshFull(liveRoom.n)}
            title={
              meshFull(liveRoom.n)
                ? meshFullMessage()
                : liveRoom.n
                  ? `${liveRoom.n} in ${liveRoom.r} right now`
                  : `start a call in ${liveRoom.r}`
            }
            onClick={() => onVoiceJoin(liveRoom.r)}
          >
            <Wave size={13} />
            {meshFull(liveRoom.n)
              ? `${liveRoom.r} is full · ${liveRoom.n}`
              : liveRoom.n
                ? `join ${liveRoom.r} · ${liveRoom.n}`
                : `join ${liveRoom.r}`}
          </button>
        ) : null}
      </header>
      <div
        className="scroll"
        ref={scroller}
        data-testid="message-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {/* The top of the room is either "there is more, fetch it" or "this
            is where the record starts". It used to be only the second, and
            it used to mean "as far back as this device happened to be
            awake for" — the log means the answer is now the circle's, not
            this device's. */}
        {hasOlder ? (
          <button
            className="button ghost wide load-older"
            data-testid="load-older"
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            {loadingOlder ? 'reading…' : `read further back in #${channel}`}
          </button>
        ) : (
          <div className="watermark" data-testid="watermark">
            <span className="wm-tag">start of record — #{channel}</span>
            Beginning of <strong>#{channel}</strong>.
          </div>
        )}
        {folded.map((item) => {
          if (item.kind === 'day') {
            return (
              <div className="day-divider" key={item.key}>
                {item.label}
              </div>
            );
          }
          if (item.kind === 'system') {
            return (
              <div className="system-chip msg system" key={item.key}>
                <span>
                  {item.m.text}
                  <time className="muted">{timeOf(item.m.ts)}</time>
                </span>
              </div>
            );
          }
          return (
            <div className="msg-group" key={item.key}>
              <Seal name={item.sender} size={34} title={item.sender} />
              <div className="msg-head">
                <span className={cx('sender', item.sender === me && 'self')}>{item.sender}</span>
                {/* Two different claims, and they must not be confused.
                    `auth` is whether this line's own signature checked out
                    against the key the roster holds for its sender — a line
                    read back from the relay can now carry that, which it
                    could not when the log was authenticated by the room key
                    alone. The check on top of it means "and I compared that
                    key's safety number myself". A line we cannot attribute
                    says so rather than borrowing either. */}
                {item.auth && item.auth !== 'signed' ? (
                  <span
                    className="sender-history"
                    role="img"
                    aria-label="sealed with the room key but not signed by its sender — authorship unverified"
                    title="sealed with the room key but not signed by its sender — authorship unverified"
                  >
                    <Archive size={10} />
                  </span>
                ) : (
                  (server.verified ?? []).includes(item.sender) && (
                    <span
                      className="sender-check"
                      role="img"
                      aria-label="safety number checked on this device"
                      title="safety number checked on this device"
                    >
                      <Check size={10} />
                    </span>
                  )
                )}
                <time>{timeOf(item.ts)}</time>
              </div>
              {item.lines.map((m, i) => (
                <div
                  className={[
                    'msg-line',
                    m.failed ? 'failed' : m.pending ? 'pending' : '',
                    acting === `${m.ts}:${i}` ? 'acting' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={`${m.ts}:${i}`}
                  data-mid={midOf(m)}
                  onClick={(e) => {
                    // Never steal a tap meant for something inside the line.
                    if (e.target.closest('button, a, input, textarea, [role="button"]')) return;
                    setActing((cur) => (cur === `${m.ts}:${i}` ? null : `${m.ts}:${i}`));
                  }}
                >
                  {m.deleted ? (
                    <span className="text deleted" data-testid="msg-deleted">
                      <Trash size={11} /> message deleted
                    </span>
                  ) : (
                    <>
                      {m.reply && (
                        <QuotedReply
                          reply={m.reply}
                          me={me}
                          onJump={
                            present.has(`${m.reply.sender}:${m.reply.ts}`)
                              ? () => jumpTo(`${m.reply.sender}:${m.reply.ts}`)
                              : null
                          }
                        />
                      )}
                      {m.file ? (
                        <Attachment key={m.file.blob} file={m.file} fetchFile={fetchFile} />
                      ) : m.game ? (
                        <GameInvite
                          game={m.game}
                          sender={m.sender}
                          me={me}
                          shelf={shelf}
                          onLaunchGame={onLaunchGame ?? (() => {})}
                        />
                      ) : (
                        <>
                          <MessageText text={m.text ?? ''} members={server.members} me={me} />
                          {m.edited && (
                            <span className="edited-tag" title="edited — the original entry stays in the log beneath it">
                              (edited)
                            </span>
                          )}
                        </>
                      )}
                      {i > 0 && <time>{timeOf(m.ts)}</time>}
                      {m.failed && onRetry ? (
                        <button
                          className="button msg-retry"
                          data-testid="msg-retry"
                          title="this message never reached the relay"
                          onClick={() => onRetry(m)}
                        >
                          failed — retry
                        </button>
                      ) : null}
                      {!server.restored && !m.pending && !m.failed ? (
                        <MessageActions
                          message={m}
                          me={me}
                          onReact={onReact}
                          onReply={onSend ? startReply : null}
                          onEdit={startEdit}
                          onDelete={onDelete}
                        />
                      ) : null}
                      <ReactionPills message={m} me={me} onReact={server.restored ? null : onReact} />
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        {!hasLines && (
          <div className="channel-empty" data-testid="channel-empty">
            <span className="ce-glyph" aria-hidden="true">
              <Lock size={18} />
            </span>
            <p className="ce-title">
              <>No messages in <strong>#{channel}</strong> yet</>
            </p>
            <p className="ce-sub muted">
              {server.restored
                ? 'This room is empty — you can read it, but sending needs a re-add.'
                : 'Say something — it’s end-to-end encrypted before it leaves this device.'}
            </p>
          </div>
        )}
      </div>
      <div className="composer-dock">
        {server.restored ? (
          <div className="composer-note restored-note" data-testid="restored-note">
            <Lock size={11} />
            read-only: loaded from your circles on the relay — ask a member to re-add{' '}
            <strong>{me}</strong> (or use an invite link) to send again
          </div>
        ) : (
        <>
        {server.outOfSync && (
          <div className="composer-note fork-note" role="status" data-testid="fork-note">
            <AlertTriangle size={13} />
            <span>
              this device is out of sync with <strong>{server.name}</strong> and cannot read new
              messages. Ask a member for a fresh invite link and open it to rejoin.
            </span>
          </div>
        )}
        {!editing && <TypingLine typing={server.typing} channel={channel} me={me} />}
        {editing ? (
          <div className="reply-bar editing" data-testid="edit-bar">
            <Pencil size={12} />
            <span className="rb-label">editing your message</span>
            <span className="rb-hint mono">Esc to cancel</span>
            <button
              type="button"
              className="rb-cancel"
              data-testid="edit-cancel"
              title="cancel edit"
              onClick={cancelEdit}
            >
              <X size={12} />
            </button>
          </div>
        ) : replyTo ? (
          <div className="reply-bar" data-testid="reply-bar">
            <Reply size={12} />
            <span className="rb-label">
              replying to <strong>{replyTo.sender === me ? 'you' : replyTo.sender}</strong>
            </span>
            <span className="rb-text">{replyTo.text?.trim() || 'attachment'}</span>
            <button
              type="button"
              className="rb-cancel"
              data-testid="reply-cancel"
              title="cancel reply"
              onClick={() => setReplyTo(null)}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) {
              if (editing) cancelEdit();
              return;
            }
            if (editing) {
              const target = editing;
              setEditing(null);
              setDraft('');
              onEdit?.(target, text);
              return;
            }
            setDraft('');
            const reply = replyTo;
            setReplyTo(null);
            onSend(text, reply);
          }}
        >
          {/* A <label> wrapping a `hidden` input is not reachable: `hidden` is
              display:none, so the input is neither focusable nor in the
              accessibility tree, the label is not focusable either, and the
              glyph inside it is aria-hidden — which left the only way to send
              a file with no keyboard path and no accessible name at all. The
              button is the control; the input is a file picker it opens, kept
              in the DOM but out of the tab order. */}
          <button
            type="button"
            className="attach"
            aria-label="attach a file"
            title="attach a file (encrypted before it leaves this device)"
            data-testid="attach"
            onClick={() => attachRef.current?.click()}
          >
            <Paperclip />
          </button>
          <input
            ref={attachRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="attach-input"
            onChange={(e) => {
              const file = e.target.files[0];
              e.target.value = '';
              if (file) onSendFile(file);
            }}
          />
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value && !editing) onType?.();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && editing) cancelEdit();
            }}
            placeholder={editing ? 'Edit your message' : `Message #${channel}`}
            aria-label={editing ? 'Edit your message' : `Message #${channel}`}
            data-testid="composer"
          />
          <span className="send-hint mono" aria-hidden="true">{editing ? '↩ save' : '↩ send'}</span>
        </form>
        <div className="composer-note">
          <Lock size={11} />
          End-to-end encrypted · {members} member{members === 1 ? '' : 's'}
        </div>
        </>
        )}
      </div>
    </main>
  );
}
