import React, { useState } from 'react';
import { Hash, Wave, Plus, Gear, Clock } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The rooms of a circle, as a strip rather than a wall.
//
// The column this replaces was IA for a product with forty rooms. At six it
// spent a fifth of the window on four words and a plus sign, and it put the
// densest thing on screen — the roster — next to the second densest. A strip
// costs one row and scales the only way a circle of six ever needs it to:
// sideways, when there are more rooms than fit.
//
// Text rooms and voice rooms are one list here, where the column had two.
// They were split because they behaved differently — you *open* a room and
// you *join* a call — but to the person crossing between them they are both
// "where the others are", and the split meant the live room was the one
// furthest down the page.

/** The rooms strip, in the order it reads: board, then rooms, then a way to
    add one. `null` is the board — the same convention App uses for "not in
    a room". */
export default function RoomStrip({
  server,
  activeChannel,
  // What the pane is showing. A strip that marks a room active while the
  // screen shows a game is the sidebar bug in a new component (§7.1).
  onStage = false,
  onGame = false,
  unreads,
  voice,
  canManage,
  onSelect,
  onSettings,
  onCreate,
  onVoiceCreate,
  onVoiceSettings,
  onVoiceJoin,
  onOpenStage,
}) {
  const [adding, setAdding] = useState(null); // null | 'room' | 'voice'
  const [name, setName] = useState('');

  const onBoard = activeChannel == null && !onStage && !onGame;
  const voiceRooms = server.voiceChannels ?? ['lounge'];

  const submit = (e) => {
    e.preventDefault();
    const value = name.trim();
    if (value) (adding === 'voice' ? onVoiceCreate : onCreate)(value);
    setName('');
    setAdding(null);
  };

  return (
    <nav className="room-strip" aria-label="rooms">
      <ul className="room-chips">
        <li>
          <button
            className={cx('room-chip', onBoard && 'active')}
            // §7.9 — the class is decoration; this is the state.
            aria-current={onBoard ? 'page' : undefined}
            data-testid="channel-overview"
            onClick={() => onSelect(null)}
          >
            board
          </button>
        </li>

        {server.channels.map((ch) => {
          const meta = server.chanMeta?.[ch] ?? {};
          const here = ch === activeChannel && !onStage && !onGame;
          const unread = here ? 0 : (unreads?.[ch] ?? 0);
          return (
            <li key={ch}>
              <button
                className={cx('room-chip', here && 'active')}
                aria-current={here ? 'page' : undefined}
                data-testid={`channel-${ch}`}
                // The count belongs in the name, not only in a badge — the
                // badge is `aria-hidden` so it is not read twice.
                aria-label={unread > 0 ? `${ch}, ${unread} unread` : undefined}
                onClick={() => onSelect(ch)}
              >
                <Hash size={14} />
                <span className="room-chip-name">{ch}</span>
                {meta.retention ? (
                  // §10.7 — the relay honours this, the mathematics does not,
                  // so the room header states it in words. Here it is only a
                  // marker that the room has one at all.
                  <span className="room-chip-flag" title={`#${ch} clears itself`}>
                    <Clock size={14} />
                    <span className="sr-only">clears itself</span>
                  </span>
                ) : null}
                {unread > 0 && (
                  <span className="unread-badge" data-testid={`chan-unread-${ch}`} aria-hidden="true">
                    {unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}

        {voiceRooms.map((ch) => {
          const live = voice.presence?.[`${server.id}/${ch}`] ?? [];
          const joined = voice.active?.server === server.id && voice.active?.channel === ch;
          // "In this call" beats "a call is happening" beats "empty room".
          const here = joined && onStage;
          return (
            <li key={`v:${ch}`}>
              <button
                className={[
                  'room-chip',
                  'voice',
                  here ? 'active' : '',
                  joined ? 'joined' : '',
                  live.length ? 'live' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={here ? 'page' : undefined}
                data-testid={joined ? `voice-open-${ch}` : `voice-join-${ch}`}
                title={joined ? 'open the call' : live.length ? `join ${ch}` : `start a call in ${ch}`}
                onClick={() => (joined ? onOpenStage() : onVoiceJoin(ch))}
              >
                <Wave size={14} />
                <span className="room-chip-name">{ch}</span>
                {/* §1.6 — the green on this chip never stands alone. */}
                {joined ? (
                  <span className="room-chip-state" data-testid={`voice-joined-${ch}`}>
                    in call
                  </span>
                ) : live.length > 0 ? (
                  <span className="room-chip-state" data-testid={`voice-live-${ch}`}>
                    {live.length} live
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}

        {adding && (
          <li>
            <form onSubmit={submit}>
              {/* §8.7 — a placeholder is a hint, never the name. */}
              <label className="sr-only" htmlFor="room-strip-new">
                {adding === 'voice' ? 'new voice room name' : 'new room name'}
              </label>
              <input
                id="room-strip-new"
                autoFocus
                className="room-chip-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={adding === 'voice' ? 'voice-room' : 'room-name'}
                data-testid={adding === 'voice' ? 'new-voice-name' : 'new-channel-name'}
              />
              {/* §11.9 — no Enter-only submits, and nothing typed here is
                  discarded on blur the way the sidebar's input was. */}
              <button className="room-chip-add-go" data-testid="new-room-create">
                add
              </button>
              <button
                type="button"
                className="room-chip-add-go"
                onClick={() => {
                  setName('');
                  setAdding(null);
                }}
              >
                cancel
              </button>
            </form>
          </li>
        )}
      </ul>

      <div className="room-strip-end">
        {/* Settings for the room you are in, rather than a gear on all
            fourteen chips. A gear per chip needed hover to stay tolerable,
            and §9.6 says a hover-gated affordance owes touch a real
            counterpart — not "always visible", which on a phone strip means
            "always in the way". Every other room's settings are one click
            (visit it) or ⌘K (§7.7). */}
        {canManage && activeChannel && !onStage && !onGame && (
          <button
            className="ghost"
            title={`#${activeChannel} settings`}
            data-testid={`channel-settings-${activeChannel}`}
            onClick={() => onSettings(activeChannel)}
          >
            <Gear size={14} />
          </button>
        )}
        {canManage && onStage && voice.active && (
          <button
            className="ghost"
            title={`${voice.active.channel} voice room settings`}
            data-testid={`voice-settings-${voice.active.channel}`}
            onClick={() => onVoiceSettings(voice.active.channel)}
          >
            <Gear size={14} />
          </button>
        )}
        {canManage && !adding && (
          <>
            <button
              className="ghost"
              title="new room"
              data-testid="new-channel"
              onClick={() => setAdding('room')}
            >
              <Plus size={14} />
              <span className="sr-only">new room</span>
            </button>
            <button
              className="ghost"
              title="new voice room"
              data-testid="new-voice"
              onClick={() => setAdding('voice')}
            >
              <Wave size={14} />
              <span className="sr-only">new voice room</span>
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
