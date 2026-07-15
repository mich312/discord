import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Plus } from './icons.jsx';

// Circles: the handful of groups you actually belong to — named rows with
// their seals, not an anonymous strip of icons. 3–6 of these, not 40.
export default function Rail({ servers, active, onSelect, onCreate }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <nav className="rail">
      <div className="section-label">
        <span className="overline"><span className="idx">01</span>circles</span>
      </div>
      <ul className="circle-list">
        {servers.map((s) => (
          <li key={s.id}>
            <button
              className={s.id === active ? 'circle-row active' : 'circle-row'}
              title={s.name}
              data-testid={`rail-${s.name}`}
              onClick={() => onSelect(s.id)}
            >
              <Seal name={s.name} size={26} />
              <span className="circle-name">{s.name}</span>
            </button>
          </li>
        ))}
        <li>
          {adding ? (
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
                placeholder="name the circle…"
                data-testid="new-server-name"
              />
            </form>
          ) : (
            <button className="circle-row add" title="found a new circle" data-testid="new-server" onClick={() => setAdding(true)}>
              <span className="add-tile">
                <Plus size={13} />
              </span>
              <span className="circle-name">new circle</span>
            </button>
          )}
        </li>
      </ul>
    </nav>
  );
}
