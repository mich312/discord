import React from 'react';
import CircleMark from './CircleMark.jsx';
import { Hash, Wave, Gamepad } from './icons.jsx';
import { describeCallLength } from '../lib/overview.js';

// Where am I? — answered in one slot, in the same place, on every screen
// inside a circle.
//
// This is the floor plan's half of a trade. Killing the rail and the channel
// column removes the thing that used to answer it: a highlighted row in a
// sidebar. §7.1 does not care which component answers, only that something
// does, in every mode — and the old sidebar failed that rule exactly when it
// mattered, keeping `# general` lit while the pane showed a call.
//
// So the marker names what the main pane is actually showing, takeovers
// included, and carries `aria-current` rather than leaving the answer to a
// class name (§7.9).

/** What the pane is showing, as a glyph and a word. */
function location({ channel, callChannel, game }) {
  if (game) return { glyph: Gamepad, label: game.name, what: 'game' };
  // A call is a place, and while the stage is up it is *the* place — naming
  // the room without saying a call is in it is the sidebar's old bug.
  if (callChannel) return { glyph: Wave, label: callChannel, what: 'call' };
  if (channel) return { glyph: Hash, label: channel, what: 'room' };
  return { glyph: null, label: 'board', what: 'board' };
}

export default function CircleMarker({
  server,
  channel,
  // The room whose call is on screen right now — not merely a call that is
  // running somewhere. The bar handles the second case.
  callChannel = null,
  game = null,
  call = null,
  now = Date.now(),
  onOpenCircle,
}) {
  const here = location({ channel, callChannel, game });
  const Glyph = here.glyph;
  return (
    <div className="circle-marker">
      {/* The marker is the page heading (§8.8): "Backroom Racing / lounge" is
          what this screen is. The call chip stays outside it — how long you
          have been talking is a status, not part of the title. */}
      <h1 className="marker-title">
      <button
        className="marker-circle"
        data-testid="marker-circle"
        title={`${server.name} — open the circle`}
        onClick={onOpenCircle}
      >
        <CircleMark id={server.id} name="" glyph={server.overview?.glyph} size={28} />
        <span className="marker-name" data-testid="server-name">
          {server.name}
        </span>
      </button>
      <span className="marker-sep" aria-hidden="true">
        /
      </span>
      <span
        className="marker-here"
        data-testid="marker-here"
        // The pane is the page; this names it. A screen reader that lands
        // here gets the same answer the sighted user gets from the fascia.
        aria-current="page"
      >
        {Glyph && <Glyph size={14} />}
        <span className="marker-here-label">{here.label}</span>
        <span className="sr-only"> — the {here.what} you are in</span>
      </span>
      </h1>
      {/* Only while the call *is* the screen. A call running in another room
          is the bar's business — it names the room, which this cannot do
          without contradicting the location it just gave. Two chrome elements
          both saying "in a call", one of them about somewhere else, is how
          the old sidebar came to keep `# general` lit during a call. */}
      {call && callChannel && (
        <span className="marker-call" data-testid="marker-call">
          {/* §1.6 — green is doing work here, so a word rides with it. */}
          <span className="marker-call-word">in a call</span>
          <span className="marker-call-len">{describeCallLength(call.since, now)}</span>
        </span>
      )}
    </div>
  );
}
