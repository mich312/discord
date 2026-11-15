import React, { useEffect, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import EncryptionNote from './EncryptionNote.jsx';
import { activitySrc, freshPresence, gameHostNote, isSameOriginSrc } from '../lib/games.js';
import { callName } from '../lib/voice.js';
import { ArrowLeft, External, Gamepad, Wave, Users, ArrowUp } from './icons.jsx';
import { cx } from '../lib/cx.js';

/** Sandbox tokens for a game frame.

    `allow-same-origin` is granted only to genuinely cross-origin games,
    where it means "keep your own origin" and costs us nothing. A frame
    served from our own origin — a bundled demo, or a registry entry
    pointing back at us — is denied it, so it runs with an opaque origin
    and cannot reach the identity key in localStorage or the MLS state in
    IndexedDB. See isSameOriginSrc. */
function frameSandbox(src) {
  const base = 'allow-scripts allow-forms allow-pointer-lock';
  return isSameOriginSrc(src) ? base : `${base} allow-same-origin`;
}

/** Whether our own server refuses to let this page frame `src`. Only
    answerable for a same-origin game (a cross-origin fetch is not allowed
    here); the headers say it before the frame turns into a blank box. */
async function refusesFraming(src) {
  if (!isSameOriginSrc(src)) return false;
  try {
    const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    const csp = res.headers.get('content-security-policy') ?? '';
    const xfo = (res.headers.get('x-frame-options') ?? '').toLowerCase();
    return /frame-ancestors\s+'none'/i.test(csp) || xfo === 'deny' || !res.ok;
  } catch {
    return false;
  }
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The in-game stage: a web game takes the main pane, the room's chat docks
// on the right, and a call you are in rides along under it. The game runs in
// a sandboxed iframe on its own server, named in the header; quorum seals
// the chat and the call, never the game's own traffic.
export default function GameStage({
  game,
  server,
  channel,
  me,
  messages,
  canSend,
  onSend,
  voice,
  onVoiceJoin,
  onVoiceLeave,
  onToggleMute,
  onInviteSeat,
  onVerify,
  onClose,
}) {
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('chat'); // chat | crew
  const [invited, setInvited] = useState(false);
  const scroller = useRef(null);
  // The frame was refused (see refusesFraming): show why, and the way out.
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  const src = activitySrc(game.url);
  useEffect(() => {
    let live = true;
    setRefused(false);
    if (src) refusesFraming(src).then((no) => live && setRefused(no));
    return () => {
      live = false;
    };
  }, [src]);
  const inCallHere = voice?.active?.server === server.id;
  const callKey = inCallHere ? `${server.id}/${voice.active.channel}` : null;
  const participants = callKey ? voice.presence[callKey] ?? [me] : [];
  const firstVoiceRoom = (server.voiceChannels ?? ['lounge'])[0];
  const hostNote = gameHostNote(game);

  return (
    <main className="game-stage" data-testid="game-stage">
      <header className="pane-head stage-head game-stage-head">
        {/* §7.2: back names where it goes. Closing a game lands on the board. */}
        <button className="ghost game-back" data-testid="game-back" onClick={onClose}>
          <ArrowLeft size={18} />
          <span>Board</span>
        </button>
        <span className="room-name">
          <span className="glyph">
            <Gamepad size={14} />
          </span>
          {game.name}
        </span>
        {/* §10.11: who can see what, said once. Chat and voice stay
            encrypted; the game's own traffic does not. */}
        <span className="game-host-note" data-testid="game-host-note">
          {hostNote}
        </span>
        <div className="stage-actions">
          {canSend && onInviteSeat && (
            <button
              className="call-btn invite-seat"
              data-testid="game-invite-seat"
              onClick={() => {
                onInviteSeat();
                setInvited(true);
                setTimeout(() => setInvited(false), 1800);
              }}
            >
              {/* It posts the game's Join card to the room: the label says
                  that, not "Invite", which is the circle link up top. */}
              <ArrowUp size={14} /> {invited ? 'Posted' : 'Post to chat'}
            </button>
          )}
          <a
            className="call-btn"
            href={game.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <External size={14} /> New tab
          </a>
        </div>
      </header>
      <div className="game-stage-body">
        {src && !refused ? (
          <iframe
            className="game-frame"
            data-testid="game-frame"
            src={src}
            title={game.name}
            sandbox={frameSandbox(src)}
            allow="fullscreen; gamepad"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="game-frame game-frame-blocked" data-testid="game-frame-blocked">
            <p className="muted">This game can&rsquo;t open here.</p>
            <a className="button" href={game.url} target="_blank" rel="noreferrer noopener">
              <External size={14} /> New tab
            </a>
          </div>
        )}
        <aside className="game-dock" data-testid="game-dock">
          <div className="dock-tabs" role="tablist">
            <button
              className={cx('dock-tab', tab === 'chat' && 'on')}
              role="tab"
              aria-selected={tab === 'chat'}
              data-testid="dock-tab-chat"
              onClick={() => setTab('chat')}
            >
              Chat
            </button>
            <button
              className={cx('dock-tab', tab === 'crew' && 'on')}
              role="tab"
              aria-selected={tab === 'crew'}
              data-testid="dock-tab-crew"
              onClick={() => setTab('crew')}
            >
              <Users size={14} /> People
            </button>
          </div>
          {tab === 'crew' ? (
            <div className="scroll dock-crew" data-testid="dock-crew">
              {server.members.map((m) => {
                const inThisCall = participants.includes(m);
                const p = freshPresence(server.presence?.[m]);
                const speaking = voice?.speaking?.includes(m);
                return (
                  <div key={m} className={cx('dock-crew-row', speaking && 'speaking')}>
                    <Seal name={m} size={24} title={m} />
                    <span className="dock-crew-name">{m}{m === me && <span className="muted"> (you)</span>}</span>
                    <span className="dock-crew-state">
                      {inThisCall ? 'In call' : p ? `Playing ${p.name}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="scroll" ref={scroller} data-testid="game-chat-scroll">
            {messages.map((m, i) =>
              m.system ? (
                <div className="stage-chat-line system" key={i}>
                  <span className="text muted">{m.text}</span>
                </div>
              ) : (
                <div className="stage-chat-line" key={i}>
                  <Seal name={m.sender} size={20} title={m.sender} />
                  <span className={cx('sender', m.sender === me && 'self')}>{m.sender}</span>
                  <span className="text">
                    {m.deleted ? 'deleted a message' : m.file ? `sent ${m.file.name}` : m.game ? `started ${m.game.name}` : m.text}
                  </span>
                  <time>{timeOf(m.ts)}</time>
                </div>
              )
            )}
          </div>
          )}
          {tab === 'chat' && canSend && (
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
                placeholder={`Message #${channel}`}
                aria-label={`Message #${channel}`}
                data-testid="game-composer"
              />
              <button type="submit" className="button primary send" disabled={!draft.trim()}>
                <ArrowUp size={14} />
                Send
              </button>
            </form>
          )}
          {/* The same encryption line as the room, so a key mismatch does
              not vanish while you chat from a game. */}
          {tab === 'chat' && <EncryptionNote server={server} me={me} onVerify={onVerify} />}
          {inCallHere ? (
            <div className="game-voice-strip" data-testid="game-voice-strip">
              <div className="game-voice-head">
                <span className="game-voice-title">
                  <Wave size={14} /> {callName(voice.active.channel, me)} · {participants.length}
                  <span className="sr-only"> in call</span>
                </span>
                <span className="game-voice-ctl">
                  {onToggleMute && !voice.listenOnly && (
                    <button
                      className={cx('button', voice.muted && 'muted-on')}
                      aria-pressed={voice.muted}
                      data-testid="game-voice-mute"
                      onClick={onToggleMute}
                    >
                      {voice.muted ? 'Unmute' : 'Mute'}
                    </button>
                  )}
                  <button className="button danger" data-testid="game-voice-leave" onClick={onVoiceLeave}>
                    Leave call
                  </button>
                </span>
              </div>
              <ul className="game-voice-row">
                {participants.map((p) => {
                  const speaking = voice.speaking?.includes(p);
                  return (
                    <li key={p} className={speaking ? 'speaking' : undefined} title={p}>
                      <Seal name={p} size={24} title={p} />
                      <VoiceMeter name={p} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="game-voice-strip empty">
              <button
                className="button"
                data-testid="game-voice-join"
                onClick={() => onVoiceJoin(firstVoiceRoom)}
              >
                <Wave size={14} /> Join {firstVoiceRoom}
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
