import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Check } from './icons.jsx';

// The roster is the security boundary: it is, exactly, who can read this
// circle. Adding someone happens here, not in a settings page, because it
// is a cryptographic act — a new epoch — not an administrative one.
export default function Members({ server, me, onAdd, onMember }) {
  const [name, setName] = useState('');

  return (
    <aside className="members">
      <div className="section-label">
        <span className="overline">roster</span>
        <span className="member-count">{server.members.length}</span>
      </div>
      <p className="roster-sub">Everyone who holds the keys to this circle — no one else can read it.</p>
      <ul className="member-list" data-testid="member-list">
        {server.members.map((m) => (
          <li key={m} className="member">
            <Seal name={m} size={26} />
            <button
              className="member-name"
              data-testid={`member-${m}`}
              disabled={m === me}
              title={m === me ? undefined : 'safety number & verification'}
              onClick={() => onMember(m)}
            >
              {m}
            </button>
            <span className="tag">
              {m === me ? (
                <span className="badge-you">you</span>
              ) : (server.verified ?? []).includes(m) ? (
                <span className="badge-verified" title="safety number checked on this device">
                  <Check size={10} /> verified
                </span>
              ) : (server.linkJoined ?? []).includes(m) ? (
                <span className="badge-unverified" title="joined via invite link; safety number not checked">
                  via link
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="add-member"
        onSubmit={(e) => {
          e.preventDefault();
          const user = name.trim().toLowerCase();
          if (!user) return;
          setName('');
          onAdd(user);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="add by handle…"
          data-testid="add-member-input"
        />
      </form>
      <p className="fineprint muted">
        Adding someone rotates the group keys (new epoch). They will see nothing sent
        before their join.
      </p>
    </aside>
  );
}
