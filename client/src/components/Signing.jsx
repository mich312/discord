import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Check, X, AlertTriangle } from './icons.jsx';
import { describeAgo } from '../lib/overview.js';
import { useDialog } from '../lib/useDialog.js';
import { awaitingFrom, canWithdraw, standingSignatures } from '../lib/quorum.js';

// "Should edda join Backroom Racing?"
//
// The one screen meant to slow somebody down: signing lets a new member read
// the circle's history, and removing them later does not take that back.
// §10.4: objecting carries the same weight as signing.

/** The signature ledger, as a row per member of the circle. */
function Ledger({ proposal, members, me }) {
  const signed = new Map(proposal.signatures.map((s) => [s.who, s]));
  const objected = new Map(proposal.objections.map((o) => [o.who, o]));
  const now = Date.now();
  return (
    <ul className="ledger">
      {members.map((m) => {
        const sig = signed.get(m);
        const obj = objected.get(m);
        // Namespaced, and deliberately: a bare `waiting` collided with a
        // global utility class that centres text, and the row silently
        // centred itself.
        const state = obj ? 'ledger-objected' : sig ? 'ledger-signed' : 'ledger-waiting';
        return (
          <li key={m} className={`ledger-row ${state}`} data-testid={`ledger-${m}`}>
            <Seal name={m} size={26} title={m} />
            <span className="ledger-who">
              {m}
              {m === me && <span className="ledger-you"> (you)</span>}
            </span>
            {/* §1.6 — every one of these states says its own name, so the
                ledger survives being read in greyscale. */}
            <span className="ledger-state">
              {obj
                ? 'Objected'
                : m === proposal.by
                  ? `Proposed ${describeAgo(proposal.at, now)}`
                  : sig
                    ? `Signed ${describeAgo(sig.at, now)}`
                    : 'Not yet'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Signing({
  proposal,
  server,
  me,
  threshold,
  verified,
  onSign,
  onObject,
  onWithdraw,
  onCompare,
  onClose,
}) {
  const [why, setWhy] = useState('');
  const [objecting, setObjecting] = useState(false);
  const members = server.members ?? [];
  const signatures = standingSignatures(proposal, members).length;
  const mine = !awaitingFrom(proposal, me);

  return (
    <div className="signing" data-testid="signing">
      <header className="signing-head">
        <h2>
          Should <strong>{proposal.handle}</strong> join {server.name}?
        </h2>
        {proposal.why && (
          <p className="signing-why">
            {proposal.by}: “{proposal.why}”
          </p>
        )}
      </header>

      <section className="signing-section">
        <h3 className="overline">
          Signatures
          <span className="signing-count" data-testid="signing-count">
            {signatures} of {threshold}
          </span>
        </h3>
        <Ledger proposal={proposal} members={members} me={me} />
      </section>

      {proposal.objections.length > 0 && (
        <section className="signing-section">
          <h3 className="overline">Objections</h3>
          <ul className="objections">
            {proposal.objections.map((o) => (
              <li key={o.who} data-testid={`objection-${o.who}`}>
                <Seal name={o.who} size={22} title={o.who} />
                <span>
                  <strong>{o.who}</strong> {o.why}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* §10.5 — the warning is the control that resolves it. It is about
          the proposer: the newcomer holds no key here yet, so there is no
          number to compare with them. */}
      {!verified && proposal.by !== me && (
        <button className="signing-unchecked" data-testid="signing-compare" onClick={onCompare}>
          <AlertTriangle size={14} />
          <span>
            <strong>You haven&rsquo;t verified {proposal.by}</strong>
          </span>
          <span className="signing-compare-go">Verify</span>
        </button>
      )}

      <section className="signing-section">
        <h3 className="overline">Once they join</h3>
        {/* Before the buttons, not after them. */}
        <ul className="signing-consequences">
          <li>{proposal.handle} can read past messages in every room.</li>
          <li>Removing them later won&rsquo;t undo what they&rsquo;ve read.</li>
        </ul>
      </section>

      {objecting ? (
        <form
          className="signing-object"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = why.trim();
            if (!reason) return;
            setWhy('');
            setObjecting(false);
            onObject(reason);
          }}
        >
          <label className="field">
            <span>Why not?</span>
            <input
              autoFocus
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              data-testid="signing-object-why"
            />
          </label>
          <p className="fineprint muted">Objecting doesn&rsquo;t cancel the proposal.</p>
          <div className="row">
            <button className="button danger" disabled={!why.trim()} data-testid="signing-object-post">
              Object
            </button>
            <button type="button" className="button" onClick={() => setObjecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="signing-actions">
          {/* §10.4 — two answers, equal weight, neither coral nor red. */}
          <button
            className="button signing-answer"
            disabled={mine}
            data-testid="signing-sign"
            onClick={onSign}
          >
            <Check size={14} />
            {mine ? 'Answered' : 'Sign'}
          </button>
          <button
            className="button signing-answer"
            disabled={mine}
            data-testid="signing-object"
            onClick={() => setObjecting(true)}
          >
            <X size={14} />
            Object
          </button>
        </div>
      )}

      {/* §7.3 — withdrawing takes the whole proposal down, so it sits well
          clear of the two answers above rather than beside them. */}
      {canWithdraw(proposal, me, server.roles?.[me] === 'admin') && (
        <button className="signing-withdraw" data-testid="signing-withdraw" onClick={onWithdraw}>
          Withdraw
        </button>
      )}
      {onClose && (
        <button className="button signing-close" data-testid="signing-close" onClick={onClose}>
          Back
        </button>
      )}
    </div>
  );
}

/**
 * The ledger as an overlay.
 *
 * Kept out of Modal.jsx deliberately: every other dialog in there is handed
 * a frozen payload, and this one has to re-render as signatures arrive from
 * other members. It reads the live record its caller passes on every render
 * instead, so the count moves while you are looking at it.
 */
export function SigningDialog({ onClose, ...props }) {
  const dialog = useDialog(onClose, { label: `Should ${props.proposal.handle} join?` });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal modal-wide"
        ref={dialog.ref}
        {...dialog.props}
        onClick={(e) => e.stopPropagation()}
      >
        <Signing {...props} onClose={onClose} />
      </div>
    </div>
  );
}
