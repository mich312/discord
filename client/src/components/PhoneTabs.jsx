import React from 'react';
import { Users, Hash, QuorumGlyph } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The three crossings, where a thumb can reach them.
//
// Only below 821px, and not because the strip stops working there — it does
// not. The strip sits under the fascia, at the top of a screen held at the
// bottom, and it is the one piece of navigation people use constantly. On a
// phone that is the wrong end.
//
// So the same three destinations the rest of the product has: the circles you
// are in, this circle's board, and its rooms. "Rooms" lands on the room you
// were last in rather than opening a list — a list of four rooms behind a tap
// is a worse answer than the room itself, and the strip is still right there
// for picking a different one.
export default function PhoneTabs({ server, channel, onStage, onGame, onCircles, onBoard, onRooms }) {
  // No circle open means no room, whatever a stale channel says. Without
  // the first clause the rooms tab lit up on circles home — marked current
  // and disabled at the same time, which is two contradictory claims.
  const inRoom = Boolean(server) && Boolean(channel) && !onStage && !onGame;
  const onBoardNow = Boolean(server) && channel == null && !onStage && !onGame;
  const tab = (key, label, Glyph, current, run, disabled = false) => (
    <li key={key}>
      <button
        className={cx('phone-tab', current && 'on')}
        // §7.9 — the class is decoration; this is the state a screen reader
        // gets, and it is the same `page` the strip and the marker use.
        aria-current={current ? 'page' : undefined}
        disabled={disabled}
        data-testid={`phone-tab-${key}`}
        onClick={run}
      >
        <Glyph size={18} />
        <span>{label}</span>
      </button>
    </li>
  );

  return (
    <nav className="phone-tabs" aria-label="circles, board and rooms">
      <ul>
        {tab('circles', 'circles', QuorumGlyph, !server, onCircles)}
        {tab('board', 'board', Users, onBoardNow, onBoard, !server)}
        {tab('rooms', 'rooms', Hash, inRoom, onRooms, !server)}
      </ul>
    </nav>
  );
}
