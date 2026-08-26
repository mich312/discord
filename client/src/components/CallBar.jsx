import React from 'react';
import Seal from './Seal.jsx';
import { Wave, Mic, MicOff, ArrowRight } from './icons.jsx';
import { describeCallLength } from '../lib/overview.js';
import { cx } from '../lib/cx.js';

// The call you are still in, following you out of the room it is in.
//
// §7.4: a control that dismisses a view while leaving a device active says
// so, and the active state is shown persistently wherever the user goes
// next. The mic is the device that matters — the failure this exists to
// prevent is somebody walking away from the call screen, believing they left,
// and staying live-mic'd in a room they can no longer see.
//
// It does not carry `leave`. Leave is on the call stage, well clear of
// anything reversible, and §7.3 is explicit about why: `close` once sat
// beside `leave call` at the same size and weight, people tapped close,
// believed they had left, and stayed live. A bar whose other control is
// "back to the call" is exactly that row rebuilt.
//
// The mic state is the mute button rather than a label beside one. It is the
// thing you reach for in a hurry, both actions are reversible, and a
// persistent indicator that is also its own control is the same shape §10.5
// asks of a warning.
export default function CallBar({ voice, me, now, onOpen, onToggleMute }) {
  const call = voice.active;
  if (!call) return null;
  const inCall = voice.presence?.[`${call.server}/${call.channel}`] ?? [me];
  const muted = !!voice.muted;

  return (
    <div className="call-bar" data-testid="call-bar" role="status">
      <span className="call-bar-glyph" aria-hidden="true">
        <Wave size={14} />
      </span>
      <span className="call-bar-where">
        {/* §1.6 — green is doing the "live" work here, and the sentence is
            what carries it if the colour does not arrive. */}
        You&rsquo;re in the <strong>{call.channel}</strong> call
      </span>

      <span className="call-bar-who">
        <span className="call-bar-orbs">
          {inCall.slice(0, 4).map((p) => (
            <Seal key={p} name={p} size={20} title={p === me ? 'you' : p} />
          ))}
        </span>
        <span className="call-bar-meta">
          {describeCallLength(call.since, now)} · {inCall.length} in
        </span>
      </span>

      <div className="call-bar-actions">
        <button
          className={cx('call-bar-mic', muted && 'muted')}
          data-testid="call-bar-mute"
          // §1.6 again — "mic on" is not conveyed by the glyph alone, and
          // §7.9: this is a toggle, so it says which way it is set.
          aria-pressed={muted}
          title={muted ? 'unmute your mic' : 'mute your mic'}
          onClick={onToggleMute}
        >
          {muted ? <MicOff size={14} /> : <Mic size={14} />}
          {muted ? 'mic off' : 'mic on'}
        </button>
        <button className="call-bar-back" data-testid="call-bar-open" onClick={onOpen}>
          back to the call
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
