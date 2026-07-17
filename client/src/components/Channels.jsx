import React, { useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { Hash, Wave, Plus, Gear, Clock, CircleGlyph } from './icons.jsx';

// Rooms and voice tables of the active circle. Channel names travel inside
// the encryption, so even this sidebar is knowledge the relay never has.
export default function Channels({
  server,
  activeChannel,
  me,
  canManage,
  onSelect,
  onSettings,
  onCreate,
  onVoiceCreate,
  onVoiceSettings,
  voice,
  onVoiceJoin,
  onVoiceLeave,
  onOpenStage,
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [addingVoice, setAddingVoice] = useState(false);
  const [voiceName, setVoiceName] = useState('');

  return (
    <aside className="channels">
      {/* The circle's home base — where clicking the circle drops you.
          activeChannel === null means "on the home base". */}
      <ul className="channel-list overview-entry">
        <li>
          <button
            className={activeChannel == null ? 'channel active' : 'channel'}
            data-testid="channel-overview"
            onClick={() => onSelect(null)}
          >
            <span className="glyph">
              <CircleGlyph size={13} />
            </span>
            home base
          </button>
        </li>
      </ul>
      <div className="section-label">
        <span className="overline"><span className="idx">02</span>rooms</span>
        {canManage && (
          <button className="ghost" title="new room" data-testid="new-channel" onClick={() => setAdding(true)}>
            <Plus size={13} />
          </button>
        )}
      </div>
      <ul className="channel-list rooms">
        {server.channels.map((ch) => {
          const meta = server.chanMeta?.[ch] ?? {};
          return (
            <li key={ch} className="room-row">
              <button
                className={ch === activeChannel ? 'channel active' : 'channel'}
                data-testid={`channel-${ch}`}
                onClick={() => onSelect(ch)}
              >
                <span className="glyph">
                  <Hash size={13} />
                </span>
                {ch}
                {meta.retention ? (
                  <span className="chan-flag" title="auto-delete is on">
                    <Clock size={11} />
                  </span>
                ) : null}
              </button>
              {canManage && (
                <button
                  className="ghost chan-gear"
                  title={`#${ch} settings`}
                  data-testid={`channel-settings-${ch}`}
                  onClick={() => onSettings(ch)}
                >
                  <Gear size={12} />
                </button>
              )}
            </li>
          );
        })}
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
        {canManage && (
          <button
            className="ghost"
            title="new voice room"
            data-testid="new-voice"
            onClick={() => setAddingVoice(true)}
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      <ul className="channel-list voice-list">
        {(server.voiceChannels ?? ['lounge']).map((ch) => {
          const key = `${server.id}/${ch}`;
          const participants = voice.presence[key] ?? [];
          const joined = voice.active?.server === server.id && voice.active?.channel === ch;
          return (
            <li key={ch} className="voice-channel">
              <div className="voice-row">
                {joined ? (
                  <button
                    className="channel joined"
                    title="open the call view"
                    data-testid={`voice-open-${ch}`}
                    onClick={onOpenStage}
                  >
                    <span className="glyph">
                      <Wave size={13} />
                    </span>
                    {ch}
                  </button>
                ) : (
                  <span className="channel">
                    <span className="glyph">
                      <Wave size={13} />
                    </span>
                    {ch}
                  </span>
                )}
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
                {canManage && onVoiceSettings && (
                  <button
                    className="ghost chan-gear"
                    title={`${ch} voice room settings`}
                    data-testid={`voice-settings-${ch}`}
                    onClick={() => onVoiceSettings(ch)}
                  >
                    <Gear size={12} />
                  </button>
                )}
              </div>
              {participants.length > 0 && (
                <ul className="voice-participants" data-testid={`voice-participants-${ch}`}>
                  {participants.map((p) => {
                    const speaking = voice.speaking?.includes(p);
                    return (
                      <li
                        key={p}
                        className={[p === me ? 'me' : '', speaking ? 'speaking' : ''].filter(Boolean).join(' ') || undefined}
                        data-testid={`voice-participant-${p}`}
                        data-speaking={speaking ? 'true' : 'false'}
                      >
                        <Seal name={p} size={16} />
                        <span className="vp-name">{p}</span>
                        {joined && <VoiceMeter name={p} />}
                        {joined && p !== me && voice.connections[p] && voice.connections[p] !== 'connected' && (
                          <span className="link-state">· {voice.connections[p]}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {addingVoice && (
          <li>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (voiceName.trim()) onVoiceCreate(voiceName.trim());
                setVoiceName('');
                setAddingVoice(false);
              }}
            >
              <input
                autoFocus
                className="channel-input"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                onBlur={() => setAddingVoice(false)}
                placeholder="voice-room"
                data-testid="new-voice-name"
              />
            </form>
          </li>
        )}
      </ul>
    </aside>
  );
}
