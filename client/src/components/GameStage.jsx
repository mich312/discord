import React, { useEffect, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { activitySrc, freshPresence, gameHost } from '../lib/games.js';
import { X, Lock, External, Gamepad, Wave, Users, LinkGlyph } from './icons.jsx';

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The in-game stage: a web game from the shelf takes the main pane while the
// room stays with you — its chat docks on the right and, when you're in a
// call, the call rides along in a strip under the chat. The game runs in a
// sandboxed iframe on ITS OWN server; the header says so plainly. quorum
// seals your chat and call — the game's host sees its own traffic, exactly
// like following a pinned link, no more and no less.
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
  onClose,
}) {
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('chat'); // chat | crew
  const [invited, setInvited] = useState(false);
  const scroller = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages]);

  const src = activitySrc(game.url);
  const inCallHere = voice?.active?.server === server.id;
  const callKey = inCallHere ? `${server.id}/${voice.active.channel}` : null;
  const participants = callKey ? voice.presence[callKey] ?? [me] : [];
  const firstVoiceRoom = (server.voiceChannels ?? ['lounge'])[0];

  return (
    <main className="game-stage" data-testid="game-stage">
      <header className="pane-head stage-head game-stage-head">
        <button className="ghost game-back" data-testid="game-back" onClick={onClose}>
          <X size={13} />
          <span>back</span>
        </button>
        <span className="room-name">
          <span className="glyph">
            <Gamepad size={14} />
          </span>
          {game.name}
        </span>
        <span className="sealed-note game-host-note" title={game.url}>
          runs on {gameHost(game)} — that host sees its own traffic, never your chat
        </span>
        <div className="stage-actions">
          {canSend && onInviteSeat && (
            <button
              className="call-btn invite-seat"
              title="drop a join card into the room"
              data-testid="game-invite-seat"
              onClick={() => {
                onInviteSeat();
                setInvited(true);
                setTimeout(() => setInvited(false), 1800);
              }}
            >
              <LinkGlyph size={13} /> {invited ? 'card sent' : 'invite seat'}
            </button>
          )}
          <a
            className="call-btn"
            title="open in its own tab"
            href={game.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <External size={13} /> open in tab
          </a>
        </div>
      </header>
      <div className="game-stage-body">
        {src ? (
          <iframe
            className="game-frame"
            data-testid="game-frame"
            src={src}
            title={game.name}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            allow="fullscreen; gamepad"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="game-frame game-frame-blocked">
            <p className="muted">
              This entry isn&rsquo;t an https:// address, so it won&rsquo;t be embedded.
            </p>
          </div>
        )}
        <aside className="game-dock" data-testid="game-dock">
          <div className="dock-tabs" role="tablist">
            <button
              className={tab === 'chat' ? 'dock-tab on' : 'dock-tab'}
              role="tab"
              aria-selected={tab === 'chat'}
              data-testid="dock-tab-chat"
              onClick={() => setTab('chat')}
            >
              #{channel}
            </button>
            <button
              className={tab === 'crew' ? 'dock-tab on' : 'dock-tab'}
              role="tab"
              aria-selected={tab === 'crew'}
              data-testid="dock-tab-crew"
              onClick={() => setTab('crew')}
            >
              <Users size={12} /> crew · {server.members.length}
            </button>
          </div>
          {tab === 'crew' ? (
            <div className="scroll dock-crew" data-testid="dock-crew">
              {server.members.map((m) => {
                const inThisCall = participants.includes(m);
                const p = freshPresence(server.presence?.[m]);
                const speaking = voice?.speaking?.includes(m);
                return (
                  <div key={m} className={speaking ? 'dock-crew-row speaking' : 'dock-crew-row'}>
                    <Seal name={m} size={22} title={m} />
                    <span className="dock-crew-name">{m === me ? `${m} · you` : m}</span>
                    <span className="dock-crew-state">
                      {inThisCall ? 'in the call' : p ? `playing ${p.name}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="scroll" ref={scroller} data-testid="game-chat-scroll">
            {messages.length === 0 && (
              <div className="stage-chat-empty muted">
                Nothing yet — trash talk lands here, sealed like any room.
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
                data-testid="game-composer"
              />
            </form>
          )}
          {inCallHere ? (
            <div className="game-voice-strip" data-testid="game-voice-strip">
              <div className="game-voice-head">
                <span className="overline live">
                  <Wave size={11} /> {voice.active.channel} — {participants.length} live
                </span>
                <span className="game-voice-ctl">
                  {onToggleMute && !voice.listenOnly && (
                    <button
                      className={voice.muted ? 'voice-join muted-on' : 'voice-join'}
                      title={voice.muted ? 'unmute your mic' : 'mute your mic'}
                      data-testid="game-voice-mute"
                      onClick={onToggleMute}
                    >
                      {voice.muted ? 'unmute' : 'mute'}
                    </button>
                  )}
                  <button className="voice-join leave" data-testid="game-voice-leave" onClick={onVoiceLeave}>
                    leave
                  </button>
                </span>
              </div>
              <ul className="game-voice-row">
                {participants.map((p) => {
                  const speaking = voice.speaking?.includes(p);
                  return (
                    <li key={p} className={speaking ? 'speaking' : undefined} title={p}>
                      <Seal name={p} size={26} title={p} />
                      <VoiceMeter name={p} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="game-voice-strip empty">
              <button
                className="voice-join"
                data-testid="game-voice-join"
                onClick={() => onVoiceJoin(firstVoiceRoom)}
              >
                <Wave size={12} /> talk while you play — join {firstVoiceRoom}
              </button>
            </div>
          )}
          <div className="composer-note">
            <Lock size={11} />
            chat &amp; call sealed — the game is not
          </div>
        </aside>
      </div>
    </main>
  );
}
