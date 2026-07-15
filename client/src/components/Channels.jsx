import React, { useState } from 'react';

export default function Channels({ server, activeChannel, me, connection, onSelect, onCreate, onInvite, onIdentity, onAlerts, voice, onVoiceJoin, onVoiceLeave }) {
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
      <div className="pane-label">voice</div>
      <ul className="channel-list voice-list">
        {(server.voiceChannels ?? ['lounge']).map((ch) => {
          const key = `${server.id}/${ch}`;
          const participants = voice.presence[key] ?? [];
          const joined = voice.active?.server === server.id && voice.active?.channel === ch;
          return (
            <li key={ch} className="voice-channel">
              <div className="voice-row">
                <span className="channel">
                  <span className="hash">))</span> {ch}
                </span>
                {joined ? (
                  <>
                    {voice.listenOnly && <span className="muted" title="no microphone found">listen-only</span>}
                    <button className="ghost danger" data-testid={`voice-leave-${ch}`} onClick={onVoiceLeave}>
                      leave
                    </button>
                  </>
                ) : (
                  <button className="ghost" data-testid={`voice-join-${ch}`} onClick={() => onVoiceJoin(ch)}>
                    join
                  </button>
                )}
              </div>
              {participants.length > 0 && (
                <ul className="voice-participants" data-testid={`voice-participants-${ch}`}>
                  {participants.map((p) => (
                    <li key={p} className={p === me ? 'mono accent' : 'mono'}>
                      {p}
                      {joined && p !== me && voice.connections[p] && voice.connections[p] !== 'connected'
                        ? ` · ${voice.connections[p]}`
                        : ''}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
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
