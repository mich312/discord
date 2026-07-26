import React, { useState } from 'react';
import { nameHue } from '../lib/avatar.js';
import { Plus } from './icons.jsx';

// The circle rail: one tile per circle, monogram on the circle's own hue.
// Still a handful of groups you actually belong to — 3–6 tiles, not 40 —
// but the names now live in the nav column's header, so the rail can be
// pure identity: color + mark, active ring, done.
function monogram(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const mark = words.length >= 2 ? words[0][0] + words[1][0] : String(name).slice(0, 2);
  return mark.toUpperCase();
}

// Counts past this read as "a lot" rather than as a number, and a four-digit
// badge would blow out the tile anyway.
const OVERFLOW = 99;

export default function Rail({ servers, active, unreads, onSelect, onCreate }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <nav className="rail">
      <ul className="circle-list">
        {servers.map((s) => {
          const hue = nameHue(s.name);
          // The circle you are looking at is being read right now; a count on
          // it would flicker up and back down as the seen marker catches up.
          const unread = s.id === active ? 0 : (unreads?.[s.id] ?? 0);
          return (
            <li key={s.id} className="rail-slot" data-unread={unread > 0 ? '' : undefined}>
              <button
                className={s.id === active ? 'circle-tile active' : 'circle-tile'}
                // The count belongs in the accessible name, not only in a
                // visual badge — the tile's own label is a two-letter
                // monogram, which tells a screen reader nothing.
                title={unread > 0 ? `${s.name} — ${unread} unread` : s.name}
                aria-label={unread > 0 ? `${s.name}, ${unread} unread` : s.name}
                data-testid={`rail-${s.name}`}
                style={{
                  background: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 42) % 360} 68% 58%))`,
                }}
                onClick={() => onSelect(s.id)}
              >
                {monogram(s.name)}
              </button>
              {unread > 0 && (
                <span
                  className="unread-badge rail-unread"
                  data-testid={`rail-unread-${s.name}`}
                  // The button already says it; announcing it twice is worse
                  // than not announcing it.
                  aria-hidden="true"
                >
                  {unread > OVERFLOW ? `${OVERFLOW}+` : unread}
                </span>
              )}
            </li>
          );
        })}
        <li className="rail-add-slot">
          <button
            className="circle-tile add"
            title="new circle"
            data-testid="new-server"
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
          </button>
          {adding && (
            <form
              className="rail-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) onCreate(name.trim());
                setName('');
                setAdding(false);
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setAdding(false)}
                placeholder="Circle name"
                data-testid="new-server-name"
              />
            </form>
          )}
        </li>
      </ul>
    </nav>
  );
}
