import React from 'react';
import Seal from './Seal.jsx';
import VoiceMeter from './VoiceMeter.jsx';
import { Phone, X } from './icons.jsx';

// The direct-call surface: an incoming ring to answer, an outgoing ring we're
// placing, or the live 1:1 call itself. A direct call is an ad-hoc voice room
// inside the circle's MLS group, so the media is E2EE exactly like a room
// call — this panel is just the ringing/answer chrome around it.
export default function CallPanel({ voice, me, onAccept, onDecline, onCancel, onHangup }) {
  // Incoming ring takes priority — someone is waiting on an answer.
  if (voice.ring) {
    return (
      <div className="call-panel ringing incoming" data-testid="call-incoming">
        <span className="call-glyph pulse">
          <Phone size={16} />
        </span>
        <Seal name={voice.ring.from} size={26} />
        <div className="call-text">
          <strong>{voice.ring.from}</strong>
          <span className="muted">incoming call…</span>
        </div>
        <button className="call-btn accept" data-testid="call-accept" onClick={onAccept}>
          <Phone size={14} /> accept
        </button>
        <button className="call-btn decline" data-testid="call-decline" onClick={onDecline}>
          <X size={14} /> decline
        </button>
      </div>
    );
  }

  // Outgoing ring: we've called someone and are waiting for them to pick up.
  if (voice.dial) {
    return (
      <div className="call-panel ringing outgoing" data-testid="call-dialing">
        <span className="call-glyph pulse">
          <Phone size={16} />
        </span>
        <Seal name={voice.dial.to} size={26} />
        <div className="call-text">
          <strong>{voice.dial.to}</strong>
          <span className="muted">ringing…</span>
        </div>
        <button className="call-btn decline" data-testid="call-cancel" onClick={onCancel}>
          <X size={14} /> cancel
        </button>
      </div>
    );
  }

  // A connected direct call (active room is a DM). Show the peer with a live
  // waveform and speaking glow, plus a hang-up.
  if (voice.direct && voice.active) {
    const key = `${voice.active.server}/${voice.active.channel}`;
    const participants = voice.presence[key] ?? [voice.direct, me];
    return (
      <div className="call-panel connected" data-testid="call-connected">
        <span className="call-glyph live">
          <Phone size={16} />
        </span>
        <ul className="call-parties">
          {participants.map((p) => (
            <li
              key={p}
              className={voice.speaking?.includes(p) ? 'speaking' : undefined}
              data-testid={`call-party-${p}`}
            >
              <Seal name={p} size={20} />
              <span className="vp-name">{p === me ? 'you' : p}</span>
              <VoiceMeter name={p} />
            </li>
          ))}
        </ul>
        <button className="call-btn decline" data-testid="call-hangup" onClick={onHangup}>
          <X size={14} /> hang up
        </button>
      </div>
    );
  }

  return null;
}
