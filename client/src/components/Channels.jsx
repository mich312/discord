import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Hash, Wave, Plus } from './icons.jsx';

// Rooms and voice tables of the active circle. Channel names travel inside
// the encryption, so even this sidebar is knowledge the relay never has.
export default function Channels({ server, activeChannel, me, onSelect, onCreate, voice, onVoiceJoin, onVoiceLeave }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <aside className="channels">
      <div className="section-label">
        <span className="overline"><span className="idx">02</span>rooms</span>
        <button className="ghost" title="new room" data-testid="new-channel" onClick={() => setAdding(true)}>
          <Plus size={13} />
        </button>
      </div>
      <ul className="channel-list rooms">
        {server.channels.map((ch) => (
          <li key={ch}>
            <button
              className={ch === activeChannel ? 'channel active' : 'channel'}
              data-testid={`channel-${ch}`}
              onClick={() => onSelect(ch)}
            >
              <span className="glyph">
                <Hash size={13} />
              </span>
              {ch}
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
                placeholder="room-name"
                data-testid="new-channel-name"
              />
            </form>
          </li>
        )}
      </ul>
      <div className="section-label">
        <span className="overline"><span className="idx">03</span>voice</span>
      </div>
      <ul className="channel-list voice-list">
        {(server.voiceChannels ?? ['lounge']).map((ch) => {
          const key = `${server.id}/${ch}`;
          const participants = voice.presence[key] ?? [];
          const joined = voice.active?.server === server.id && voice.active?.channel === ch;
          return (
            <li key={ch} className="voice-channel">
              <div className="voice-row">
                <span className="channel">
                  <span className="glyph">
                    <Wave size={13} />
                  </span>
                  {ch}
                </span>
                {joined ? (
                  <>
                    {voice.listenOnly && (
                      <span className="listen-only" title="no microphone found — hearing others, sending nothing">
                        listen-only
                      </span>
                    )}
                    <button className="voice-join leave" data-testid={`voice-leave-${ch}`} onClick={onVoiceLeave}>
                      leave
                    </button>
                  </>
                ) : (
                  <button className="voice-join" data-testid={`voice-join-${ch}`} onClick={() => onVoiceJoin(ch)}>
                    join
                  </button>
                )}
              </div>
              {participants.length > 0 && (
                <ul className="voice-participants" data-testid={`voice-participants-${ch}`}>
                  {participants.map((p) => (
                    <li key={p} className={p === me ? 'me' : undefined}>
                      <Seal name={p} size={16} />
                      {p}
                      {joined && p !== me && voice.connections[p] && voice.connections[p] !== 'connected' && (
                        <span className="link-state">· {voice.connections[p]}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
