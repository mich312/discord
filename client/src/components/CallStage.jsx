import React, { useEffect, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { Wave, X, Lock, Screen, Mic, MicOff } from './icons.jsx';

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// One participant's screen in the share stage. The stream is a live
// MediaStream from the mesh (or my own capture) — it never leaves the
// peer connections, so this <video> is the only place it exists on screen.
function ScreenTile({ stream, name, mine }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play?.().catch(() => {
      /* pre-gesture autoplay block — the join click normally suffices */
    });
  }, [stream]);
  return (
    <div className="stage-screen" data-testid="stage-screen">
      <video ref={ref} autoPlay playsInline muted data-testid={`stage-screen-video-${name}`} />
      <span className="stage-screen-label">
        <Screen size={12} />
        {mine ? 'your screen' : `${name}'s screen`}
      </span>
    </div>
  );
}

// The call stage: a full-pane dashboard for the room you're in — a bubble
// per participant (speaking glow + live meter), the shared screen front and
// center when someone presents, and the call's own conversation thread.
// Everything here is the same E2EE machinery as the rest of the app: media
// is P2P, chat is MLS-sealed, the relay sees none of it in the clear.
export default function CallStage({
  voice,
  manager,
  me,
  messages,
  canSend,
  onSend,
  onShare,
  onStopShare,
  onToggleMute,
  onLeave,
  onClose,
}) {
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState(null);
  const scroller = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  const { server, channel } = voice.active;
  const key = `${server}/${channel}`;
  const participants = voice.presence[key] ?? [me];
  const sharing = voice.sharing ?? [];
  const iShare = sharing.includes(me);
  const direct = voice.direct;
  const title = direct ? `call · ${direct}` : channel;

  // Which screen fills the stage: the one the user clicked, as long as that
  // person is still presenting; otherwise the first live share.
  const shown = focus && sharing.includes(focus) ? focus : sharing[0] ?? null;
  const shownStream = shown ? manager.screenStreamFor(shown) : null;

  return (
    <main className="call-stage" data-testid="call-stage">
      <header className="pane-head stage-head">
        <span className="room-name">
          <span className="glyph">
            <Wave size={13} />
          </span>
          {title}
        </span>
        <span className="stage-count">
          {participants.length} in call
          {voice.listenOnly && (
            <span className="listen-only" title="no microphone found — hearing others, sending nothing">
              {' '}· listen-only
            </span>
          )}
        </span>
        <div className="stage-actions">
          {onToggleMute && !voice.listenOnly && (
            <button
              className={voice.muted ? 'call-btn muted-on' : 'call-btn'}
              title={voice.muted ? 'unmute your mic' : 'mute your mic'}
              data-testid="stage-mute"
              onClick={onToggleMute}
            >
              {voice.muted ? <MicOff size={14} /> : <Mic size={14} />}
              {voice.muted ? ' unmute' : ' mute'}
            </button>
          )}
          {iShare ? (
            <button className="call-btn decline" data-testid="share-stop" onClick={onStopShare}>
              <Screen size={14} /> stop sharing
            </button>
          ) : (
            <button className="call-btn" data-testid="share-start" onClick={onShare}>
              <Screen size={14} /> share screen
            </button>
          )}
          <button className="call-btn" data-testid="stage-close" title="back to text rooms" onClick={onClose}>
            <X size={14} /> close
          </button>
          <button className="call-btn decline" data-testid="stage-leave" onClick={onLeave}>
            leave call
          </button>
        </div>
      </header>
      <div className="stage-body">
        <section className="stage-main" data-testid="stage-main">
          {shown &&
            (shownStream ? (
              <ScreenTile stream={shownStream} name={shown} mine={shown === me} />
            ) : (
              <div className="stage-screen waiting" data-testid="stage-screen-waiting">
                <Screen size={22} />
                <span>waiting for {shown}'s screen…</span>
              </div>
            ))}
          {sharing.length > 1 && (
            <div className="stage-sharers">
              {sharing.map((name) => (
                <button
                  key={name}
                  className={name === shown ? 'sharer-pill active' : 'sharer-pill'}
                  data-testid={`sharer-pill-${name}`}
                  onClick={() => setFocus(name)}
                >
                  <Screen size={11} />
                  {name === me ? 'you' : name}
                </button>
              ))}
            </div>
          )}
          <ul className={shown ? 'stage-bubbles compact' : 'stage-bubbles'} data-testid="stage-bubbles">
            {participants.map((p) => {
              const speaking = voice.speaking?.includes(p);
              const conn = p === me ? null : voice.connections[p];
              return (
                <li
                  key={p}
                  className={speaking ? 'stage-bubble speaking' : 'stage-bubble'}
                  data-testid={`stage-bubble-${p}`}
                  data-speaking={speaking ? 'true' : 'false'}
                >
                  <span className="bubble-seal">
                    <Seal name={p} size={shown ? 44 : 72} title={p} />
                  </span>
                  <span className="bubble-name">{p === me ? 'you' : p}</span>
                  <VoiceMeter name={p} />
                  {sharing.includes(p) && (
                    <span className="bubble-badge" data-testid={`bubble-sharing-${p}`}>
                      <Screen size={11} /> sharing
                    </span>
                  )}
                  {p !== me && voice.mutedPeers?.includes(p) && (
                    <span className="bubble-badge muted-badge" data-testid={`bubble-muted-${p}`}>
                      <MicOff size={11} /> muted
                    </span>
                  )}
                  {conn && conn !== 'connected' && <span className="bubble-conn">{conn}</span>}
                </li>
              );
            })}
          </ul>
        </section>
        <aside className="stage-chat" data-testid="stage-chat">
          <div className="stage-chat-head">
            <span>call chat</span>
          </div>
          <div className="scroll" ref={scroller} data-testid="stage-chat-scroll">
            {messages.length === 0 && (
              <div className="stage-chat-empty muted">
                Nothing yet — messages here stay with this {direct ? 'call' : 'room'}.
              </div>
            )}
            {messages.map((m, i) =>
              m.system ? (
                <div className="stage-chat-line system" key={i}>
                  <span className="text muted">{m.text}</span>
                </div>
              ) : (
                <div className="stage-chat-line" key={i}>
                  <Seal name={m.sender} size={18} title={m.sender} />
                  <span className={m.sender === me ? 'sender self' : 'sender'}>{m.sender}</span>
                  <span className="text">
                    {m.file ? `sent a file: ${m.file.name}` : m.game ? `opened ${m.game.name}` : m.text}
                  </span>
                  <time>{timeOf(m.ts)}</time>
                </div>
              )
            )}
          </div>
          {canSend && (
            <form
              className="stage-composer"
              onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (!text) return;
                setDraft('');
                onSend(text);
              }}
            >
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message the call`}
                data-testid="stage-composer"
              />
            </form>
          )}
          <div className="composer-note">
            <Lock size={11} />
            End-to-end encrypted
          </div>
        </aside>
      </div>
    </main>
  );
}
