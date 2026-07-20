import React, { useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { Hash, Wave, Plus, Gear, Clock, Gamepad } from './icons.jsx';

// Rooms and voice rooms of the active circle. Room names travel inside the
// encryption, so even this sidebar is knowledge the relay never has.
export default function Channels({
  server,
  activeChannel,
  me,
  canManage,
  unreads,
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
      <div className="circle-head">
        <div className="circle-head-name">{server.name}</div>
        <div className="circle-head-meta mono">
          {server.members.length} member{server.members.length === 1 ? '' : 's'}
        </div>
      </div>
      {/* The circle's game hub — where clicking the circle drops you.
          activeChannel === null means "on the hub". */}
      <ul className="channel-list overview-entry">
        <li>
          <button
            className={activeChannel == null ? 'channel active' : 'channel'}
            data-testid="channel-overview"
            onClick={() => onSelect(null)}
          >
            <span className="glyph">
              <Gamepad size={14} />
            </span>
            game hub
          </button>
        </li>
      </ul>
      <div className="section-label">
        <span className="overline">rooms</span>
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
                {ch !== activeChannel && (unreads?.[ch] ?? 0) > 0 && (
                  <span className="unread-badge chan-unread" data-testid={`chan-unread-${ch}`}>
                    {unreads[ch]}
                  </span>
                )}
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
        <span className="overline">voice</span>
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
                    {participants.length > 0 && (
                      <span className="live-chip" data-testid={`voice-live-${ch}`}>
                        {participants.length} live
                      </span>
                    )}
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
                ) : participants.length === 0 ? (
                  <button className="voice-join" data-testid={`voice-join-${ch}`} onClick={() => onVoiceJoin(ch)}>
                    join
                  </button>
                ) : null}
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
              {participants.length > 0 && !joined && (
                <div className="voice-live-card" data-testid={`voice-participants-${ch}`}>
                  <span className="overline voice-live-label">live in {ch}</span>
                  <span className="sr-only">{participants.join(', ')}</span>
                  <div className="voice-live-row">
                    <span className="voice-live-stack">
                      {participants.slice(0, 4).map((p) => (
                        <Seal key={p} name={p} size={24} title={p} />
                      ))}
                      {participants.length > 4 && (
                        <span className="voice-live-more">+{participants.length - 4}</span>
                      )}
                    </span>
                    <button
                      className="voice-join-pill"
                      data-testid={`voice-join-${ch}`}
                      onClick={() => onVoiceJoin(ch)}
                    >
                      join
                    </button>
                  </div>
                </div>
              )}
              {joined && (
                <div className="voice-joined-card" data-testid={`voice-participants-${ch}`}>
                  <span className="overline voice-live-label">in call · {ch}</span>
                  <ul className="voice-participants">
                    {(participants.length ? participants : [me]).map((p) => {
                      const speaking = voice.speaking?.includes(p);
                      return (
                        <li
                          key={p}
                          className={[p === me ? 'me' : '', speaking ? 'speaking' : ''].filter(Boolean).join(' ') || undefined}
                          data-testid={`voice-participant-${p}`}
                          data-speaking={speaking ? 'true' : 'false'}
                        >
                          <Seal name={p} size={16} />
                          <span className="vp-name">{p === me ? 'you' : p}</span>
                          <VoiceMeter name={p} />
                          {p !== me && voice.connections[p] && voice.connections[p] !== 'connected' && (
                            <span className="link-state">· {voice.connections[p]}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
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
