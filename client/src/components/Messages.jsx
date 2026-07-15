import React, { useEffect, useRef, useState } from 'react';

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB{error ? ` — ${error}` : ''}
    </button>
  );
}

export default function Messages({ server, channel, me, messages, onSend, onSendFile, fetchFile }) {
  const [draft, setDraft] = useState('');
  const scroller = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  return (
    <main className="messages-pane">
      <header className="pane-head">
        <h2>
          <span className="hash">#</span> {channel}
        </h2>
        <span className="muted">messages exist only on the devices in the member list</span>
      </header>
      <div className="scroll" ref={scroller} data-testid="message-scroll">
        <div className="watermark" data-testid="watermark">
          — beginning of <strong>#{channel}</strong> as this device knows it. Earlier messages,
          if any, were encrypted with keys this device never had. —
        </div>
        {messages.map((m, i) =>
          m.system ? (
            <div className="msg system" key={i}>
              <span className="muted">{m.text}</span>
              <time className="muted">{timeOf(m.ts)}</time>
            </div>
          ) : (
            <div className="msg" key={i}>
              <span className={m.sender === me ? 'sender self' : 'sender'}>{m.sender}</span>
              {m.file ? (
                <span className="text">
                  <Attachment file={m.file} fetchFile={fetchFile} />
                </span>
              ) : (
                <span className="text">{m.text}</span>
              )}
              <time className="muted">{timeOf(m.ts)}</time>
            </div>
          )
        )}
      </div>
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
        <label className="attach" title="attach a file (encrypted before upload)">
          +
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`message #${channel} — encrypted for ${server.members.length} member${server.members.length === 1 ? '' : 's'}`}
          data-testid="composer"
        />
      </form>
    </main>
  );
}
