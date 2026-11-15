import React from 'react';
import CircleMark from './CircleMark.jsx';
import { Gamepad } from './icons.jsx';

// Which circle you are in, as the page heading. Rooms and calls are marked
// by the strip below (with aria-current), so the room is not repeated here;
// a game takes over the whole pane and has no chip, so it is named.
export default function CircleMarker({
  server,
  game = null,
  onOpenCircle,
}) {
  return (
    <div className="circle-marker">
      <h1 className="marker-title">
        <button className="marker-circle" data-testid="marker-circle" onClick={onOpenCircle}>
          <CircleMark id={server.id} name="" glyph={server.overview?.glyph} size={28} />
          <span className="marker-name" data-testid="server-name">
            {server.name}
          </span>
        </button>
        {game && (
          <>
            <span className="marker-sep" aria-hidden="true">
              /
            </span>
            <span className="marker-here" data-testid="marker-here" aria-current="page">
              <Gamepad size={14} />
              <span className="marker-here-label">{game.name}</span>
            </span>
          </>
        )}
      </h1>
    </div>
  );
}
