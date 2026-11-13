import React, { useEffect, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import EncryptionNote from './EncryptionNote.jsx';
import { Wave, Screen, Mic, MicOff, Camera, CameraOff, ArrowLeft, ArrowUp, Minimize, Phone } from './icons.jsx';
import { cx } from '../lib/cx.js';

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
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        aria-label={`${name}'s shared screen`}
        data-testid={`stage-screen-video-${name}`}
      />
      <span className="stage-screen-label">
        <Screen size={14} />
        {mine ? 'Your screen' : `${name}’s screen`}
      </span>
    </div>
  );
}

// A participant's camera, shown in place of their avatar in the bubble. Mine
// is mirrored (like every selfie preview) and muted; remote legs carry no
// audio track anyway, but muting is belt-and-braces against feedback.
function CameraTile({ stream, name, mine }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play?.().catch(() => {});
  }, [stream]);
  return (
    <video
      ref={ref}
      className={cx('bubble-cam', mine && 'mirror')}
      autoPlay
      playsInline
      muted
      aria-label={mine ? 'your camera' : `${name}'s camera`}
      data-testid={`bubble-cam-video-${name}`}
    />
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
  // The circle the call is in, for the encryption line under the chat.
  server: circle,
  // Where "back" goes, named (§7.2): the room or board the call covers.
  backLabel = 'Back',
  onVerify,
  messages,
  canSend,
  onSend,
  onShare,
  onStopShare,
  onCamera,
  onStopCamera,
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
  const cameras = voice.cameras ?? [];
  const iCam = cameras.includes(me);
  const direct = voice.direct;
  const title = direct ? `Call with ${direct}` : channel;

  // Which screen fills the stage: the one the user clicked, as long as that
  // person is still presenting; otherwise the first live share.
  const shown = focus && sharing.includes(focus) ? focus : sharing[0] ?? null;
  const shownStream = shown ? manager.screenStreamFor(shown) : null;

  return (
    <main className="call-stage" data-testid="call-stage">
      {/* §7.2 — a takeover gets a back control on the left that names where
          it goes. The way out used to be "close", far right, eight pixels
          from "leave call" at the same size (§7.3). */}
      <header className="pane-head stage-head">
        <button className="ghost stage-back" data-testid="stage-back" onClick={onClose}>
          <ArrowLeft size={18} />
          <span>{backLabel}</span>
        </button>
        <h2 className="room-name">
          <span className="glyph">
            <Wave size={14} />
          </span>
          {title}
        </h2>
        <span className="stage-count">
          {participants.length} in call
          {voice.listenOnly && (
            <span className="listen-only"> · Listen only: no microphone found</span>
          )}
        </span>
      </header>
      <div className="stage-body">
        <section className="stage-main" data-testid="stage-main">
          {shown &&
            (shownStream ? (
              <ScreenTile stream={shownStream} name={shown} mine={shown === me} />
            ) : (
              <div className="stage-screen waiting" data-testid="stage-screen-waiting">
                <Screen size={24} />
                <span>Waiting for {shown}’s screen…</span>
              </div>
            ))}
          {sharing.length > 1 && (
            <div className="stage-sharers">
              {sharing.map((name) => (
                <button
                  key={name}
                  className={cx('sharer-pill', name === shown && 'active')}
                  data-testid={`sharer-pill-${name}`}
                  onClick={() => setFocus(name)}
                >
                  <Screen size={14} />
                  {name === me ? 'You' : name}
                </button>
              ))}
            </div>
          )}
          <ul className={cx('stage-bubbles', shown && 'compact')} data-testid="stage-bubbles">
            {participants.map((p) => {
              const speaking = voice.speaking?.includes(p);
              const conn = p === me ? null : voice.connections[p];
              const camStream = cameras.includes(p) ? manager.cameraStreamFor(p) : null;
              return (
                <li
                  key={p}
                  className={cx('stage-bubble', speaking && 'speaking')}
                  data-testid={`stage-bubble-${p}`}
                  data-speaking={speaking ? 'true' : 'false'}
                >
                  {/* Speaking was a green ring and nothing else — invisible to
                      a screen reader and to anyone who cannot separate the
                      hue. Not a live region: who is talking changes several
                      times a second and would be a firehose. */}
                  {speaking && <span className="sr-only">{p} is speaking</span>}
                  <span className={cx('bubble-seal', camStream && 'has-cam')}>
                    {camStream ? (
                      <CameraTile stream={camStream} name={p} mine={p === me} />
                    ) : (
                      <Seal name={p} size={shown ? 44 : 72} title={p} />
                    )}
                  </span>
                  <span className="bubble-name">
                    {p}
                    {p === me && <span className="muted"> (you)</span>}
                  </span>
                  <VoiceMeter name={p} />
                  {cameras.includes(p) && !camStream && (
                    <span className="bubble-badge" data-testid={`bubble-camera-waiting-${p}`}>
                      <Camera size={14} /> Camera starting…
                    </span>
                  )}
                  {sharing.includes(p) && (
                    <span className="bubble-badge" data-testid={`bubble-sharing-${p}`}>
                      <Screen size={14} /> Sharing
                    </span>
                  )}
                  {p !== me && voice.mutedPeers?.includes(p) && (
                    <span className="bubble-badge muted-badge" data-testid={`bubble-muted-${p}`}>
                      <MicOff size={14} /> Muted
                    </span>
                  )}
                  {p === me && voice.muted && (
                    <span className="bubble-badge muted-badge" data-testid="bubble-muted-you">
                      <MicOff size={14} /> Muted
                    </span>
                  )}
                  {conn && conn !== 'connected' && <span className="bubble-conn">{conn}</span>}
                </li>
              );
            })}
          </ul>
          {/* The controls dock under the people, the way every call app
              places them. Leaving sits apart from everything reversible —
              a divider and a gap, in red — and hiding the call says the mic
              stays live (§7.3, §7.4). */}
          <div className="stage-dock" role="toolbar" aria-label="Call controls">
            {onToggleMute && !voice.listenOnly && (
              <button
                className={cx('button', voice.muted && 'muted-on')}
                aria-pressed={voice.muted}
                aria-keyshortcuts="m"
                data-testid="stage-mute"
                onClick={onToggleMute}
              >
                {voice.muted ? <MicOff size={18} /> : <Mic size={18} />}
                {voice.muted ? 'Unmute' : 'Mute'}
              </button>
            )}
            {onCamera &&
              (iCam ? (
                <button className="button muted-on" data-testid="camera-stop" onClick={onStopCamera}>
                  <CameraOff size={18} /> Stop camera
                </button>
              ) : (
                <button className="button" data-testid="camera-start" onClick={onCamera}>
                  <Camera size={18} /> Camera
                </button>
              ))}
            {iShare ? (
              <button className="button muted-on" data-testid="share-stop" onClick={onStopShare}>
                <Screen size={18} /> Stop sharing
              </button>
            ) : (
              <button className="button" data-testid="share-start" onClick={onShare}>
                <Screen size={18} /> Share screen
              </button>
            )}
            <button className="button ghost" data-testid="stage-close" onClick={onClose}>
              <Minimize size={18} />
              Hide call
              {!voice.muted && !voice.listenOnly && <span className="muted"> · mic stays on</span>}
            </button>
            <span className="stage-dock-gap" aria-hidden="true" />
            <button className="button danger" data-testid="stage-leave" onClick={onLeave}>
              <Phone size={18} />
              Leave
            </button>
          </div>
        </section>
        <aside className="stage-chat" data-testid="stage-chat" aria-labelledby="stage-chat-title">
          <div className="stage-chat-head">
            <h3 id="stage-chat-title">Chat</h3>
          </div>
          <div className="scroll" ref={scroller} data-testid="stage-chat-scroll">
            {messages.length === 0 && (
              <div className="stage-chat-empty muted">
                No messages yet. They stay with this {direct ? 'call' : 'room'}.
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
                  <span className={cx('sender', m.sender === me && 'self')}>{m.sender}</span>
                  <span className="text">
                    {m.file ? `sent a file: ${m.file.name}` : m.game ? `started ${m.game.name}` : m.text}
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
                placeholder={direct ? `Message ${direct}` : `Message ${channel}`}
                aria-label={direct ? `Message ${direct}` : `Message ${channel}`}
                data-testid="stage-composer"
              />
              <button type="submit" className="button primary send" disabled={!draft.trim()}>
                <ArrowUp size={14} />
                Send
              </button>
            </form>
          )}
          {circle && <EncryptionNote server={circle} me={me} onVerify={onVerify} />}
        </aside>
      </div>
    </main>
  );
}
