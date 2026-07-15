import React, { useState } from 'react';

// Server rail: 3–6 servers, not 40. Initial-letter tiles, quiet.
export default function Rail({ servers, active, connection, onSelect, onCreate }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  return (
    <nav className="rail">
      <div className={`conn-dot ${connection}`} title={`relay: ${connection}`} data-testid="conn-dot" />
      {servers.map((s) => (
        <button
          key={s.id}
          className={s.id === active ? 'rail-tile active' : 'rail-tile'}
          title={s.name}
          data-testid={`rail-${s.name}`}
          onClick={() => onSelect(s.id)}
        >
          {s.name.slice(0, 1).toUpperCase()}
        </button>
      ))}
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
            placeholder="server name"
            data-testid="new-server-name"
          />
        </form>
      ) : (
        <button className="rail-tile add" title="new server" data-testid="new-server" onClick={() => setAdding(true)}>
          +
        </button>
      )}
    </nav>
  );
}
