import React, { useEffect, useRef, useState } from 'react';

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Messages({ server, channel, me, messages, onSend }) {
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
              <span className="text">{m.text}</span>
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
