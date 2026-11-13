import React from 'react';
import { Lock } from './icons.jsx';
import { cx } from '../lib/cx.js';

/** Members of a circle whose safety number nobody has compared on this
    device. Same definition everywhere the count is shown — the room header,
    the board and this line — so they cannot disagree. A mismatched member
    is not "unchecked": they were checked and failed, and say so elsewhere. */
export function uncheckedMembers(server, me) {
  return (server.members ?? []).filter(
    (m) => m !== me && !(server.verified ?? []).includes(m) && !server.mismatched?.[m]
  );
}

/** The one encryption line on a surface that carries a conversation.
 *
 *  §10.1 — the claim is a function of state, not a static string. It read
 *  "End-to-end encrypted · 4 members" with two of the four unverified, which
 *  is precisely the case that needed qualifying.
 *  §10.3 — it says whom it covers.
 *  §10.5 — the qualification is the control that resolves it.
 */
export default function EncryptionNote({ server, me, onVerify, className }) {
  const members = (server.members ?? []).length;
  const unchecked = uncheckedMembers(server, me).length;
  return (
    <div
      className={cx('composer-note', unchecked > 0 && 'unchecked', className)}
      data-testid="composer-note"
    >
      <Lock size={14} />
      {unchecked > 0 ? (
        <span>
          Encrypted for {members} member{members === 1 ? '' : 's'}.{' '}
          {onVerify ? (
            <button className="linkish" data-testid="composer-unchecked" onClick={onVerify}>
              {unchecked} {unchecked === 1 ? 'isn’t' : 'aren’t'} verified yet
            </button>
          ) : (
            <>
              {unchecked} {unchecked === 1 ? 'isn’t' : 'aren’t'} verified yet
            </>
          )}
        </span>
      ) : members > 1 ? (
        <span>Encrypted for {members} verified members</span>
      ) : (
        <span>Encrypted on this device. Nobody else is in {server.name} yet.</span>
      )}
    </div>
  );
}
