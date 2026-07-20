import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { freshPresence } from '../lib/games.js';
import { describeAgo } from '../lib/overview.js';
import { Check, Phone } from './icons.jsx';

// The roster is the security boundary: it is, exactly, who can read this
// circle. Adding someone happens here, not in a settings page, because it
// is a cryptographic act — a new epoch — not an administrative one.
// Roles are relay-side and weaker: admins manage the ACL (adding members,
// invites, promotions), but they gain no read access anyone else lacks.
// Presence shown here is only what this device truly knows: who is in a
// call (MLS voice signaling) and who says they're in a game (MLS rich
// presence, expired client-side). No invented "online" dots.
export default function Members({ server, me, canManage, voice, onAdd, onMember, onSetRole, onCall }) {
  const [name, setName] = useState('');
  const roles = server.roles ?? {};
  const now = Date.now();

  // Who is in which of this circle's voice rooms right now.
  const inRoom = {};
  for (const room of server.voiceChannels ?? ['lounge']) {
    for (const p of voice?.presence?.[`${server.id}/${room}`] ?? []) {
      if (!(p in inRoom)) inRoom[p] = room;
    }
  }
  // Who claims to be in a game right now (fresh claims only).
  const playing = {};
  for (const [handle, entry] of Object.entries(server.presence ?? {})) {
    const game = freshPresence(entry, now);
    if (game) playing[handle] = { game, ts: entry.ts };
  }

  const occupiedRooms = [...new Set(Object.values(inRoom))];
  const inCallSet = new Set(Object.keys(inRoom).filter((m) => server.members.includes(m)));
  const playingOnly = server.members.filter((m) => !inCallSet.has(m) && playing[m]);
  const rest = server.members.filter((m) => !inCallSet.has(m) && !playing[m]);
  const liveCount = inCallSet.size + playingOnly.length;

  const row = (m) => {
    const speaking = voice?.speaking?.includes(m);
    const p = playing[m];
    return (
      <li key={m} className={speaking ? 'member speaking' : 'member'}>
        <Seal name={m} size={26} />
        <span className="member-col">
          <button
            className="member-name"
            data-testid={`member-${m}`}
            disabled={m === me}
            title={m === me ? undefined : 'safety number & verification'}
            onClick={() => onMember(m)}
          >
            {m}
          </button>
          {p ? (
            <span className="member-presence" data-testid={`member-playing-${m}`}>
              playing <span className="game">{p.game.name}</span>
              {inRoom[m] ? '' : ` · ${describeAgo(p.ts, now).replace(' ago', '')}`}
            </span>
          ) : inRoom[m] ? (
            <span className="member-presence" data-testid={`member-in-call-${m}`}>
              in {inRoom[m]}
            </span>
          ) : null}
        </span>
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
    );
  };

  return (
    <aside className="members">
      <div className="section-label">
        <span className="overline">members</span>
        {liveCount > 0 ? (
          <span className="member-count live" title="in a call or in a game right now">
            {liveCount} live
          </span>
        ) : (
          <span className="member-count">{server.members.length}</span>
        )}
      </div>
      {occupiedRooms.map((room) => {
        const here = server.members.filter((m) => inRoom[m] === room);
        return (
          <React.Fragment key={room}>
            <div className="section-label member-group live">
              <span className="overline">in {room} — {here.length}</span>
            </div>
            <ul className="member-list in-call" data-testid="member-list-call">
              {here.map(row)}
            </ul>
          </React.Fragment>
        );
      })}
      {playingOnly.length > 0 && (
        <>
          <div className="section-label member-group playing">
            <span className="overline">playing — {playingOnly.length}</span>
          </div>
          <ul className="member-list in-call">{playingOnly.map(row)}</ul>
        </>
      )}
      <ul className="member-list" data-testid="member-list">
        {rest.map(row)}
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
        New members can&rsquo;t see messages sent before they joined.
      </p>
    </aside>
  );
}
