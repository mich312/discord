import React, { useEffect, useMemo, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import { describeRetention } from '../lib/controller.js';
import { userTint } from '../lib/identicon.js';
import { Lock, Paperclip, Clock, Plus } from './icons.jsx';

// The quick palette: enough to carry tone, few enough to stay a gesture.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];

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
  }, []);

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

// Reaction chips + the hover trigger for one message line. Reactions are
// stored on the message as {emoji: [handles]}; clicking a chip toggles
// your own mark on it.
function Reactions({ message, me, onReact }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(message.reactions ?? {}).filter(([, users]) => users.length);
  if (!onReact && !entries.length) return null;
  return (
    <span className="reactions">
      {entries.map(([emoji, users]) => (
        <button
          key={emoji}
          className={users.includes(me) ? 'reaction mine' : 'reaction'}
          title={users.join(', ')}
          data-testid={`reaction-${emoji}`}
          onClick={() => onReact?.(message, emoji)}
        >
          {emoji} <span className="count">{users.length}</span>
        </button>
      ))}
      {onReact && (
        <span className="react-anchor">
          <button
            className="react-trigger"
            title="add reaction"
            data-testid="react-trigger"
            onClick={() => setOpen((v) => !v)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          >
            <Plus size={11} />
          </button>
          {open && (
            <span className="react-palette" data-testid="react-palette">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  className="react-option"
                  data-testid={`react-option-${emoji}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

// "who is typing" — ephemeral presence above the composer, names in their
// identity colors, dots doing the waiting.
function TypingLine({ typing }) {
  if (!typing.length) return null;
  return (
    <div className="typing-line" data-testid="typing-line">
      <span className="typing-dots" aria-hidden="true">
        <i /><i /><i />
      </span>
      {typing.map((name, i) => (
        <React.Fragment key={name}>
          {i > 0 && (i === typing.length - 1 ? ' and ' : ', ')}
          <span className="uc" style={userTint(name)}>{name}</span>
        </React.Fragment>
      ))}
      {typing.length === 1 ? ' is typing…' : ' are typing…'}
    </div>
  );
}

export default function Messages({
  server,
  channel,
  me,
  messages,
  typing = [],
  onSend,
  onSendFile,
  onTyping,
  onReact,
  fetchFile,
}) {
  const [draft, setDraft] = useState('');
  const scroller = useRef(null);
  const folded = useMemo(() => fold(messages), [messages]);
  const members = server.members.length;
  const meta = server.chanMeta?.[channel] ?? {};
  const keepsHistory = !!meta.hid;

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
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
        <span className="sealed-note">
          {keepsHistory
            ? 'history kept for joiners — sealed by a room key the relay never sees'
            : 'messages exist only on the devices in the roster'}
          {meta.retention ? (
            <span className="retention-note" title="auto-delete is on for this room">
              {' '}· <Clock size={11} /> auto-deletes {describeRetention(meta.retention)} after sending
            </span>
          ) : null}
        </span>
      </header>
      <div className="scroll" ref={scroller} data-testid="message-scroll">
        <div className="watermark" data-testid="watermark">
          <span className="wm-tag">start of record — #{channel}</span>
          {keepsHistory ? (
            <>
              Beginning of <strong>#{channel}</strong> as this device knows it. This room keeps
              encrypted history, so what you see may include messages restored with the room key.
            </>
          ) : (
            <>
              Beginning of <strong>#{channel}</strong> as this device knows it. Earlier messages,
              if any, were encrypted with keys this device never had.
            </>
          )}
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
              <Seal name={item.sender} size={32} title={item.sender} />
              <div className="msg-head">
                <span
                  className={item.sender === me ? 'sender uc self' : 'sender uc'}
                  style={userTint(item.sender)}
                >
                  {item.sender}
                </span>
                <time>{timeOf(item.ts)}</time>
              </div>
              {item.lines.map((m, i) => (
                <div className="msg-line" key={i}>
                  {m.file ? (
                    <Attachment file={m.file} fetchFile={fetchFile} />
                  ) : (
                    <span className="text">{m.text}</span>
                  )}
                  <Reactions message={m} me={me} onReact={onReact} />
                  {i > 0 && <time>{timeOf(m.ts)}</time>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="composer-dock">
        <TypingLine typing={typing} />
        {server.restored ? (
          <div className="composer-note restored-note" data-testid="restored-note">
            <Lock size={11} />
            read-only: restored from your encrypted backup — ask a member to re-add{' '}
            <strong>{me}</strong> (or use an invite link) to send again
          </div>
        ) : (
        <>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            onSend(text);
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
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value) onTyping?.();
            }}
            placeholder={`Message #${channel}`}
            data-testid="composer"
          />
        </form>
        <div className="composer-note">
          <Lock size={11} />
          end-to-end sealed for {members} member{members === 1 ? '' : 's'} — nothing readable leaves this device
        </div>
        </>
        )}
      </div>
    </main>
  );
}
