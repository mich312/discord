import React, { useEffect, useMemo, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import { Lock, Paperclip, Seal8 } from './icons.jsx';

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

export default function Messages({ server, channel, me, messages, onSend, onSendFile, fetchFile }) {
  const [draft, setDraft] = useState('');
  const scroller = useRef(null);
  const folded = useMemo(() => fold(messages), [messages]);
  const members = server.members.length;

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
        <span className="sealed-note">
          messages exist only on the devices in the roster
        </span>
      </header>
      <div className="scroll" ref={scroller} data-testid="message-scroll">
        <div className="watermark" data-testid="watermark">
          <span className="stamp">
            <Seal8 size={17} />
          </span>
          Beginning of <strong>#{channel}</strong> as this device knows it. Earlier messages,
          if any, were encrypted with keys this device never had.
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
                <time>{timeOf(item.ts)}</time>
              </div>
              {item.lines.map((m, i) => (
                <div className="msg-line" key={i}>
                  {m.file ? (
                    <Attachment file={m.file} fetchFile={fetchFile} />
                  ) : (
                    <span className="text">{m.text}</span>
                  )}
                  {i > 0 && <time>{timeOf(m.ts)}</time>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="composer-dock">
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
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message #${channel}`}
            data-testid="composer"
          />
        </form>
        <div className="composer-note">
          <Lock size={11} />
          end-to-end sealed for {members} member{members === 1 ? '' : 's'} — nothing readable leaves this device
        </div>
      </div>
    </main>
  );
}
