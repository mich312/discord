import React, { useEffect, useMemo, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import { describeRetention, freshTyping } from '../lib/controller.js';
import { nameHue } from '../lib/avatar.js';
import { Lock, Paperclip, Clock, Wave, Gamepad, Check, Plus, Reply, X } from './icons.jsx';

// The reaction palette: small on purpose. Reactions ride MLS like any
// message and live on the stored message; kept-history skips them.
const EMOJI = ['👍', '🔥', '😂', '❤️', '💀', '😮'];

function Reactions({ message, me, onReact }) {
  const [picking, setPicking] = useState(false);
  const reacts = message.reacts ?? {};
  const entries = Object.entries(reacts).filter(([, who]) => who.length);
  if (!entries.length && !onReact) return null;
  const target = { sender: message.sender, ts: message.ts };
  return (
    <span className={entries.length ? 'reacts' : 'reacts empty'}>
      {entries.map(([emo, who]) => (
        <button
          key={emo}
          className={who.includes(me) ? 'react on' : 'react'}
          title={who.join(', ')}
          data-testid={`react-${emo}`}
          onClick={() => onReact?.(target, emo)}
        >
          {emo} {who.length}
        </button>
      ))}
      {onReact && (
        <span className="react-add-wrap">
          <button
            className="react react-add"
            title="add reaction"
            data-testid="react-add"
            onClick={() => setPicking((v) => !v)}
          >
            <Plus size={11} />
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
    </span>
  );
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
      className={onJump ? 'reply-quote' : 'reply-quote orphan'}
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

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'today';
  if (same(d, yesterday)) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// Fold the flat message list into day dividers, system chips, and groups of
// consecutive lines from one sender within a five-minute window.
const GROUP_WINDOW = 5 * 60 * 1000;
function fold(messages) {
  const out = [];
  let day = null;
  let group = null;
  for (const m of messages) {
    const label = dayLabel(m.ts);
    if (label !== day) {
      out.push({ kind: 'day', label, key: `d${m.ts}` });
      day = label;
      group = null;
    }
    if (m.system) {
      out.push({ kind: 'system', m, key: `s${m.ts}${out.length}` });
      group = null;
      continue;
    }
    if (group && group.sender === m.sender && m.ts - group.last < GROUP_WINDOW) {
      group.lines.push(m);
      group.last = m.ts;
    } else {
      group = { kind: 'group', sender: m.sender, ts: m.ts, last: m.ts, lines: [m], key: `g${m.ts}${out.length}` };
      out.push(group);
    }
  }
  return out;
}

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
    if (!url) return <span className="muted">decrypting {file.name}…</span>;
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
  onLaunchGame,
  onReact,
  onRetry,
  onType,
}) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const inputRef = useRef(null);
  const scroller = useRef(null);
  // Which lines this device actually holds — a reply's "jump to original"
  // only lights up when the quoted line is one of them.
  const present = useMemo(() => new Set(messages.map(midOf)), [messages]);
  // A reply pins to one message; if that message drops out from under us
  // (retention, channel switch), quietly abandon the reply.
  useEffect(() => {
    if (replyTo && !present.has(`${replyTo.sender}:${replyTo.ts}`)) setReplyTo(null);
  }, [present, replyTo]);
  const startReply = (m) => {
    setReplyTo(quoteOf(m));
    inputRef.current?.focus();
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

  useEffect(() => {
    if (pinned.current) scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  return (
    <main className="messages-pane">
      <header className="pane-head">
        <span className="room-name">
          <span className="glyph">
            <Lock size={13} />
          </span>
          {channel}
        </span>
        {meta.topic && (
          <span className="room-topic" data-testid="channel-topic-display" title={meta.topic}>
            {meta.topic}
          </span>
        )}
        {meta.retention ? (
          <span className="sealed-note">
            <span className="retention-note" title="auto-delete is on for this room">
              <Clock size={11} /> auto-deletes {describeRetention(meta.retention)} after sending
            </span>
          </span>
        ) : null}
        {inCallHere && onOpenStage ? (
          <button className="button pane-call live" data-testid="pane-open-call" onClick={onOpenStage}>
            <Wave size={13} />
            open call
          </button>
        ) : liveRoom && onVoiceJoin ? (
          <button
            className={liveRoom.n ? 'button pane-call live' : 'button pane-call'}
            data-testid="pane-join-voice"
            title={liveRoom.n ? `${liveRoom.n} in ${liveRoom.r} right now` : `start a call in ${liveRoom.r}`}
            onClick={() => onVoiceJoin(liveRoom.r)}
          >
            <Wave size={13} />
            {liveRoom.n ? `join ${liveRoom.r} · ${liveRoom.n}` : `join ${liveRoom.r}`}
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
        <div className="watermark" data-testid="watermark">
          <span className="wm-tag">start of record — #{channel}</span>
          Beginning of <strong>#{channel}</strong> as this device knows it.
        </div>
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
                <span className={item.sender === me ? 'sender self' : 'sender'}>{item.sender}</span>
                {(server.verified ?? []).includes(item.sender) && (
                  <span className="sender-check" title="safety number checked on this device">
                    <Check size={10} />
                  </span>
                )}
                <time>{timeOf(item.ts)}</time>
              </div>
              {item.lines.map((m, i) => (
                <div
                  className={m.failed ? 'msg-line failed' : m.pending ? 'msg-line pending' : 'msg-line'}
                  key={`${m.ts}:${i}`}
                  data-mid={midOf(m)}
                >
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
                    <span className="text">{m.text}</span>
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
                  {!server.restored && onSend && !m.pending && !m.failed ? (
                    <button
                      className="react msg-reply"
                      data-testid="msg-reply"
                      title="reply"
                      onClick={() => startReply(m)}
                    >
                      <Reply size={11} />
                    </button>
                  ) : null}
                  <Reactions message={m} me={me} onReact={server.restored ? null : onReact} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="composer-dock">
        {server.restored ? (
          <div className="composer-note restored-note" data-testid="restored-note">
            <Lock size={11} />
            read-only: restored from your encrypted backup — ask a member to re-add{' '}
            <strong>{me}</strong> (or use an invite link) to send again
          </div>
        ) : (
        <>
        <TypingLine typing={server.typing} channel={channel} me={me} />
        {replyTo && (
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
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            const reply = replyTo;
            setReplyTo(null);
            onSend(text, reply);
          }}
        >
          <label className="attach" title="attach a file (encrypted before it leaves this device)">
            <Paperclip />
            <input
              type="file"
              hidden
              data-testid="attach-input"
              onChange={(e) => {
                const file = e.target.files[0];
                e.target.value = '';
                if (file) onSendFile(file);
              }}
            />
          </label>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value) onType?.();
            }}
            placeholder={`Message #${channel}`}
            aria-label={`Message #${channel}`}
            data-testid="composer"
          />
          <span className="send-hint mono" aria-hidden="true">↩ send</span>
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
