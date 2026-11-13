import React from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { Phone, Screen, X, Mic, MicOff } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The direct-call surface: an incoming ring to answer, an outgoing ring we're
// placing, or the live 1:1 call itself. A direct call is an ad-hoc voice room
// inside the circle's MLS group, so the media is E2EE exactly like a room
// call — this panel is just the ringing/answer chrome around it. While the
// call stage is open it owns the connected chrome, so only rings show here.
export default function CallPanel({ voice, me, stageOpen, onAccept, onDecline, onCancel, onHangup, onToggleMute, onOpen }) {
  // Incoming ring takes priority — someone is waiting on an answer.
  if (voice.ring) {
    return (
      <div className="call-panel ringing incoming" data-testid="call-incoming">
        <span className="call-glyph pulse">
          <Phone size={18} />
        </span>
        <Seal name={voice.ring.from} size={26} />
        <div className="call-text">
          <strong>{voice.ring.from}</strong>
          <span className="muted">Incoming call…</span>
        </div>
        <button className="call-btn accept" data-testid="call-accept" onClick={onAccept}>
          <Phone size={14} /> Accept
        </button>
        <button className="call-btn decline" data-testid="call-decline" onClick={onDecline}>
          <X size={14} /> Decline
        </button>
      </div>
    );
  }

  // Outgoing ring: we've called someone and are waiting for them to pick up.
  if (voice.dial) {
    return (
      <div className="call-panel ringing outgoing" data-testid="call-dialing">
        <span className="call-glyph pulse">
          <Phone size={18} />
        </span>
        <Seal name={voice.dial.to} size={26} />
        <div className="call-text">
          <strong>{voice.dial.to}</strong>
          <span className="muted">Ringing…</span>
        </div>
        <button className="call-btn decline" data-testid="call-cancel" onClick={onCancel}>
          <X size={14} /> Cancel
        </button>
      </div>
    );
  }

  // A connected direct call (active room is a DM). Show the peer with a live
  // waveform and speaking glow, plus a hang-up.
  if (voice.direct && voice.active && !stageOpen) {
    const key = `${voice.active.server}/${voice.active.channel}`;
    const participants = voice.presence[key] ?? [voice.direct, me];
    return (
      <div className="call-panel connected" data-testid="call-connected">
        <span className="call-glyph live">
          <Phone size={18} />
        </span>
        <ul className="call-parties">
          {participants.map((p) => (
            <li
              key={p}
              className={voice.speaking?.includes(p) ? 'speaking' : undefined}
              data-testid={`call-party-${p}`}
            >
              <Seal name={p} size={20} />
              <span className="vp-name">{p === me ? 'You' : p}</span>
              <VoiceMeter name={p} />
            </li>
          ))}
        </ul>
        {onToggleMute && !voice.listenOnly && (
          <button
            className={cx('call-btn', voice.muted && 'muted-on')}
            data-testid="call-mute"
            aria-label={voice.muted ? 'Unmute' : 'Mute'}
            aria-pressed={voice.muted}
            aria-keyshortcuts="m"
            title={voice.muted ? 'Unmute (M)' : 'Mute (M)'}
            onClick={onToggleMute}
          >
            {voice.muted ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
        )}
        <button className="call-btn" data-testid="call-open-stage" onClick={onOpen}>
          <Screen size={14} /> Open call
        </button>
        {/* §7.3 — hanging up is the irreversible one, so it sits apart. */}
        <button className="call-btn decline call-hangup" data-testid="call-hangup" onClick={onHangup}>
          <X size={14} /> Hang up
        </button>
      </div>
    );
  }

  return null;
}
