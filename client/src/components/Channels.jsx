import React, { useState } from 'react';

export default function Channels({ server, activeChannel, me, connection, onSelect, onCreate, onInvite, onIdentity, onAlerts }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <aside className="channels">
      <header className="pane-head">
        <h2 data-testid="server-name">{server.name}</h2>
        <span className="muted mono">epoch {server.epoch}</span>
        <button className="ghost push-right" title="create invite link" data-testid="create-invite" onClick={onInvite}>
          invite
        </button>
      </header>
      <div className="pane-label">
        channels
        <button className="ghost" title="new channel" data-testid="new-channel" onClick={() => setAdding(true)}>
          +
        </button>
      </div>
      <ul className="channel-list">
        {server.channels.map((ch) => (
          <li key={ch}>
            <button
              className={ch === activeChannel ? 'channel active' : 'channel'}
              data-testid={`channel-${ch}`}
              onClick={() => onSelect(ch)}
            >
              <span className="hash">#</span> {ch}
            </button>
          </li>
        ))}
        {adding && (
          <li>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) onCreate(name.trim());
                setName('');
                setAdding(false);
              }}
            >
              <input
                autoFocus
                className="channel-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setAdding(false)}
                placeholder="channel-name"
                data-testid="new-channel-name"
              />
            </form>
          </li>
        )}
      </ul>
      <footer className="self">
        <span className="mono" data-testid="self-name">{me}</span>
        <button className="ghost" title="identity key" data-testid="identity-open" onClick={onIdentity}>
          key
        </button>
        <button className="ghost" title="enable push notifications" data-testid="enable-notifications" onClick={onAlerts}>
          alerts
        </button>
        <span className={`muted conn-${connection}`}>{connection}</span>
      </footer>
    </aside>
  );
}
