import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Check, Phone } from './icons.jsx';

// The roster is the security boundary: it is, exactly, who can read this
// circle. Adding someone happens here, not in a settings page, because it
// is a cryptographic act — a new epoch — not an administrative one.
// Roles are relay-side and weaker: admins manage the ACL (adding members,
// invites, promotions), but they gain no read access anyone else lacks.
export default function Members({ server, me, canManage, onAdd, onMember, onSetRole, onCall }) {
  const [name, setName] = useState('');
  const roles = server.roles ?? {};

  return (
    <aside className="members">
      <div className="section-label">
        <span className="overline"><span className="idx">04</span>roster</span>
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
            {m !== me && onCall && (
              <button
                className="ghost member-call"
                data-testid={`call-${m}`}
                title={`call ${m}`}
                onClick={() => onCall(m)}
              >
                <Phone size={13} />
              </button>
            )}
            <span className="tag">
              {roles[m] === 'admin' && (
                <span className="badge-admin" title="manages membership and invites for this circle">
                  admin
                </span>
              )}
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
              {canManage && m !== me && roles[m] && (
                <button
                  className="ghost role-toggle"
                  data-testid={`role-toggle-${m}`}
                  title={roles[m] === 'admin' ? 'demote to member' : 'promote to admin'}
                  onClick={() => onSetRole(m, roles[m] === 'admin' ? 'member' : 'admin')}
                >
                  {roles[m] === 'admin' ? '− admin' : '+ admin'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canManage ? (
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
      ) : (
        <p className="fineprint muted">Only admins of this circle can add members.</p>
      )}
      <p className="fineprint muted">
        Adding someone rotates the group keys (new epoch). They will see nothing sent
        before their join.
      </p>
    </aside>
  );
}
