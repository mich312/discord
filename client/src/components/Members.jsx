import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { circlePresence } from '../lib/presence.js';
import { normalizeThreshold } from '../lib/quorum.js';
import { describeAgo } from '../lib/overview.js';
import { memberVtName } from '../lib/viewTransition.js';
import { Check, Phone, X, AlertTriangle } from './icons.jsx';
import { cx } from '../lib/cx.js';

// The roster is the security boundary: it is, exactly, who can read this
// circle. Adding someone happens here, not in a settings page, because it
// is a cryptographic act — a new epoch — not an administrative one.
// Roles are relay-side and weaker: admins manage the ACL (adding members,
// invites, promotions), but they gain no read access anyone else lacks.
/** The circle's own answer, or the majority it would have chosen. */
const thresholdFor = (server) =>
  normalizeThreshold(server?.threshold, (server?.members ?? []).length);

// Presence shown here is only what this device truly knows: who is in a
// call (MLS voice signaling) and who says they're in a game (MLS rich
// presence, expired client-side). No invented "online" dots.
export default function Members({
  server,
  me,
  canManage,
  voice,
  onPropose,
  onMember,
  onSetRole,
  onCall,
  onRemoveMember,
}) {
  const [name, setName] = useState('');
  const roles = server.roles ?? {};
  const adminCount = Object.values(roles).filter((r) => r === 'admin').length;
  const now = Date.now();
  // What this circle asks of itself before it lets somebody in.
  const needed = thresholdFor(server);

  // Who is in a call, and who claims to be in a game. Shared with circles
  // home so a card saying "3 here now" and this list naming them cannot
  // disagree.
  const { inRoom, playing } = circlePresence(server, voice, now);

  const occupiedRooms = [...new Set(Object.values(inRoom))];
  const inCallSet = new Set(Object.keys(inRoom).filter((m) => server.members.includes(m)));
  const playingOnly = server.members.filter((m) => !inCallSet.has(m) && playing[m]);
  const rest = server.members.filter((m) => !inCallSet.has(m) && !playing[m]);
  const liveCount = inCallSet.size + playingOnly.length;
  // Everyone whose key nobody on this device has checked. Deliberately not
  // just the link-joiners: a member added by hand is equally unchecked — they
  // arrived with someone vouching for them socially rather than
  // cryptographically. The badge below distinguishes provenance; this count
  // does not, because the work outstanding is the same either way.
  const unchecked = server.members.filter(
    (m) => m !== me && !(server.verified ?? []).includes(m) && !server.mismatched?.[m]
  );

  const row = (m) => {
    const speaking = voice?.speaking?.includes(m);
    const p = playing[m];
    return (
      <li
        key={m}
        className={cx('member', speaking && 'speaking')}
        // Stable per-member name so the browser slides the row (FLIP) as it
        // moves between the rest / in-call / playing groups, rather than
        // cross-dissolving it. Named only while it's a real roster row.
        style={{ viewTransitionName: memberVtName(m) }}
      >
        {speaking && <span className="sr-only">{m} is speaking</span>}
        <Seal name={m} size={32} />
        <span className="member-col">
          <span className="member-line">
            {/* §4.1 — a name is the most human thing in the product, so it is
                set in the sans, like it is in the transcript. It was mono
                here, the one place the whole roster is in view. */}
            <button
              className="member-name"
              data-testid={`member-${m}`}
              disabled={m === me}
              title={m === me ? undefined : 'Safety number and verification'}
              onClick={() => onMember(m)}
            >
              {m}
            </button>
            {m === me && <span className="member-you">(you)</span>}
            {roles[m] === 'admin' && <span className="badge">Admin</span>}
            {m !== me && (server.linkJoined ?? []).includes(m) && (
              <span className="badge" data-testid={`badge-link-${m}`}>
                Joined by link
              </span>
            )}
            {m !== me && (server.verified ?? []).includes(m) && !server.mismatched?.[m] && (
              <span
                className="member-verified"
                role="img"
                aria-label="Verified on this device"
                data-testid={`badge-verified-${m}`}
              >
                <Check size={14} />
              </span>
            )}
          </span>
          {p ? (
            <span className="member-presence" data-testid={`member-playing-${m}`}>
              <span className="live-dot" aria-hidden="true" />
              Playing <span className="game">{p.game.name}</span>
              {inRoom[m] ? '' : ` · ${describeAgo(p.ts, now).replace(' ago', '')}`}
            </span>
          ) : inRoom[m] ? (
            <span className="member-presence" data-testid={`member-in-call-${m}`}>
              <span className="live-dot" aria-hidden="true" />
              In {inRoom[m]}
            </span>
          ) : null}
        </span>
        <span className="tag">
          {m === me ? null : /* A found mismatch outranks every other state.
                 Losing a ✓ must render as a loss, not as the absence of a
                 mark — "no badge" is what an unchecked stranger looks like,
                 and this is not that (§10.9). */
            server.mismatched?.[m] ? (
            <button
              className="button danger badge-mismatch"
              data-testid={`badge-mismatch-${m}`}
              onClick={() => onMember(m)}
            >
              <AlertTriangle size={14} />
              Key mismatch
            </button>
          ) : (server.verified ?? []).includes(m) ? null : (
            // §10.5 — an unverified member carries the control that verifies
            // them, not only a badge for the ones who came by link. A member
            // added by hand is equally unchecked.
            <button
              className="button warn"
              data-testid={(server.linkJoined ?? []).includes(m) ? `badge-unverified-${m}` : `verify-${m}`}
              onClick={() => onMember(m)}
            >
              Verify
            </button>
          )}
          {m !== me && onCall && (
            <button
              className="ghost member-call"
              data-testid={`call-${m}`}
              aria-label={`Call ${m}`}
              title={`Call ${m}`}
              onClick={() => onCall(m)}
            >
              <Phone size={14} />
            </button>
          )}
          {canManage && m !== me && roles[m] && (
            <button
              className="ghost role-toggle"
              data-testid={`role-toggle-${m}`}
              onClick={() => onSetRole(m, roles[m] === 'admin' ? 'member' : 'admin')}
            >
              {roles[m] === 'admin' ? 'Remove admin' : 'Make admin'}
            </button>
          )}
          {canManage && m !== me && onRemoveMember && !(roles[m] === 'admin' && adminCount <= 1) && (
            <button
              className="ghost member-remove danger"
              data-testid={`remove-member-${m}`}
              aria-label={`Remove ${m} from the circle`}
              title={`Remove ${m} from the circle`}
              onClick={() => {
                if (window.confirm(`Remove ${m} from ${server.name}? They lose access immediately.`)) {
                  onRemoveMember(m);
                }
              }}
            >
              <X size={14} />
            </button>
          )}
        </span>
      </li>
    );
  };

  return (
    <section className="members" id="roster-drawer" aria-labelledby="members-title">
      <div className="section-label">
        <h3 className="members-title" id="members-title">
          People
        </h3>
        <span className="member-count">
          {server.members.length} member{server.members.length === 1 ? '' : 's'}
          {liveCount > 0 && ` · ${liveCount} here now`}
        </span>
        {/* The product had no surface that ever asked anyone to verify: the
            flow existed and nothing pointed at it, so an unchecked member
            stayed unchecked forever. The count is the prompt, and it is the
            button — opening the first outstanding comparison is one tap from
            the roster rather than a tooltip nobody sees on touch. */}
        {unchecked.length > 0 && (
          <button
            className="member-unchecked"
            data-testid="unchecked-count"
            onClick={() => onMember(unchecked[0])}
          >
            <AlertTriangle size={14} />
            {unchecked.length} not verified
          </button>
        )}
      </div>
      {occupiedRooms.map((room) => {
        const here = server.members.filter((m) => inRoom[m] === room);
        return (
          <React.Fragment key={room}>
            <div className="member-group">
              <span className="live-dot" aria-hidden="true" />
              In {room} · {here.length}
            </div>
            {/* Who is in this room right now. The sidebar used to carry a
                second copy of this as a join card; with the column gone the
                roster is the one place that names them, so it keeps the
                per-room hook the rest of the product looks for. */}
            <ul
              className="member-list in-call"
              data-testid="member-list-call"
              data-room={room}
            >
              {here.map(row)}
            </ul>
          </React.Fragment>
        );
      })}
      {playingOnly.length > 0 && (
        <>
          <div className="member-group">
            <span className="live-dot" aria-hidden="true" />
            Playing · {playingOnly.length}
          </div>
          <ul className="member-list in-call">{playingOnly.map(row)}</ul>
        </>
      )}
      <ul className="member-list" data-testid="member-list">
        {rest.map(row)}
      </ul>
      {/* Anyone may put a name forward — that is the point, and gating it on
          a role would put membership back in one person's hands. What
          happens next depends on the circle: in a circle of one there is
          nobody else to ask and it goes straight through, which is why this
          reads the same either way. */}
      <form
        className="add-member"
        onSubmit={(e) => {
          e.preventDefault();
          const user = name.trim().toLowerCase();
          if (!user) return;
          setName('');
          onPropose(user);
        }}
      >
        {/* §8.7 — a real, visible label, not a placeholder standing in. */}
        <label className="add-member-label" htmlFor="propose-handle">
          Add someone
        </label>
        <span className="add-member-row">
          <input
            id="propose-handle"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their handle"
            aria-describedby={needed > 1 ? 'propose-help' : undefined}
            data-testid="add-member-input"
          />
          <button className="button" data-testid="propose-member">
            {needed > 1 ? 'Propose' : 'Add'}
          </button>
        </span>
      </form>
      {needed > 1 && (
        <p className="fineprint muted" id="propose-help">
          A new member needs {needed} of the {server.members.length} members to sign. Admins
          can&rsquo;t add people on their own.
        </p>
      )}
    </section>
  );
}
