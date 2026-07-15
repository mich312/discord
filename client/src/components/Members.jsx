import React, { useState } from 'react';

// The member list is the security boundary: it is, exactly, who can read
// this server. Adding someone is done from here, not a settings page.
export default function Members({ server, me, onAdd }) {
  const [name, setName] = useState('');

  return (
    <aside className="members">
      <div className="pane-label">
        members — who can read this
        <span className="mono muted">{server.members.length}</span>
      </div>
      <ul className="member-list" data-testid="member-list">
        {server.members.map((m) => (
          <li key={m} className="member">
            <span className="mono">{m}</span>
            {m === me ? (
              <span className="muted">you</span>
            ) : (server.linkJoined ?? []).includes(m) ? (
              <span className="badge-unverified" title="joined via invite link; safety number not checked">
                via link · unverified
              </span>
            ) : null}
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
          placeholder="add member by handle"
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
