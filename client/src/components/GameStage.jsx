import React, { useEffect, useRef, useState } from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { activitySrc, freshPresence, gameHostNote, isSameOriginSrc } from '../lib/games.js';
import { ArrowLeft, External, Gamepad, Wave, Users, LinkGlyph, ArrowUp } from './icons.jsx';
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
        {/* §7.2 and §6.2 — a back control names where it goes and points
            that way. It was an X labelled "back". */}
        <button className="ghost game-back" data-testid="game-back" onClick={onClose}>
          <ArrowLeft size={18} />
          <span>#{channel}</span>
        </button>
        <span className="room-name">
          <span className="glyph">
            <Gamepad size={14} />
          </span>
          {game.name}
        </span>
        {/* The one honesty line on this surface (§10.11). The dock used to
            repeat it in capitals at the bottom; it is said here, once. */}
        <span className="sealed-note game-host-note" data-testid="game-host-note">
          {gameHostNote(game)}
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
              <LinkGlyph size={14} /> {invited ? 'Invite sent' : 'Invite to game'}
            </button>
          )}
          <a
            className="call-btn"
            href={game.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <External size={14} /> Open in new tab
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
            sandbox={frameSandbox(src)}
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
              className={cx('dock-tab', tab === 'chat' && 'on')}
              role="tab"
              aria-selected={tab === 'chat'}
              data-testid="dock-tab-chat"
              onClick={() => setTab('chat')}
            >
              #{channel}
            </button>
            <button
              className={cx('dock-tab', tab === 'crew' && 'on')}
              role="tab"
              aria-selected={tab === 'crew'}
              data-testid="dock-tab-crew"
              onClick={() => setTab('crew')}
            >
              <Users size={14} /> Members · {server.members.length}
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
                    <Seal name={m} size={22} title={m} />
                    <span className="dock-crew-name">{m}{m === me && <span className="muted"> (you)</span>}</span>
                    <span className="dock-crew-state">
                      {inThisCall ? 'In the call' : p ? `Playing ${p.name}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
          <div className="scroll" ref={scroller} data-testid="game-chat-scroll">
            {messages.length === 0 && (
              <div className="stage-chat-empty muted">
                No messages yet.
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
          {inCallHere ? (
            <div className="game-voice-strip" data-testid="game-voice-strip">
              <div className="game-voice-head">
                <span className="game-voice-title">
                  <Wave size={14} /> {voice.active.channel} · {participants.length}
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
