import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Check, X, AlertTriangle, ShieldCheck } from './icons.jsx';
import { describeAgo } from '../lib/overview.js';
import { useDialog } from '../lib/useDialog.js';
import { awaitingFrom, canWithdraw, standingSignatures } from '../lib/quorum.js';

// "Should edda join Backroom Racing?"
//
// The one screen in the product whose job is to slow somebody down. Everything
// else here is built to get out of the way; this is built so that the person
// about to sign reads what their signature does before it does it — because
// it is the only irreversible thing the product offers, and it is irreversible
// in a way that is easy not to notice: a new member can read everything the
// room keys unlock, back to the first message anyone sent, and removing them
// later does not take that back.
//
// §10.4: the trust-denying action carries the same weight as the granting one.
// A dialog whose only button increases trust is a consent funnel.

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
            <Seal name={m} size={26} title={m === me ? 'you' : m} />
            <span className="ledger-who">
              {m}
              {m === me && <span className="ledger-you"> · you</span>}
            </span>
            {/* §1.6 — every one of these states says its own name, so the
                ledger survives being read in greyscale. */}
            <span className="ledger-state mono">
              {obj
                ? 'objected'
                : m === proposal.by
                  ? `proposed · ${describeAgo(proposal.at, now)}`
                  : sig
                    ? `signed · ${describeAgo(sig.at, now)}`
                    : 'not yet'}
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
  const togo = Math.max(0, threshold - signatures);
  const mine = !awaitingFrom(proposal, me);
  const rooms = server.channels ?? [];
  const clearing = rooms.filter((ch) => server.chanMeta?.[ch]?.retention);

  return (
    <div className="signing" data-testid="signing">
      <header className="signing-head">
        <h2>
          Should <strong>{proposal.handle}</strong> join {server.name}?
        </h2>
        <p className="muted">
          {proposal.by === me ? 'You' : proposal.by} put them forward{' '}
          {describeAgo(proposal.at, Date.now())}. The circle set its threshold at{' '}
          {threshold} {threshold === 1 ? 'signature' : 'signatures'} — change that the same way
          you change anything else here.
        </p>
        {proposal.why && <p className="signing-why">“{proposal.why}” — {proposal.by}</p>}
      </header>

      <section className="signing-section">
        <h3 className="overline">
          signatures
          <span className="signing-count mono" data-testid="signing-count">
            {signatures} of {threshold}
            {togo > 0 ? ` · ${togo} to go` : ' · carried'}
          </span>
        </h3>
        <Ledger proposal={proposal} members={members} me={me} />
      </section>

      {proposal.objections.length > 0 && (
        <section className="signing-section">
          <h3 className="overline">objections</h3>
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

      {/* §10.5 — a warning is the control that resolves it, one tap from
          here rather than a tooltip.

          The warning is about the proposer, not the newcomer, and that is
          not a shortcut: {proposal.handle} holds no key in this circle yet,
          so there is no number to compare with them and saying "unverified"
          about them would be a warning nobody could act on. What you can
          check is the member vouching for them — and if you have not
          compared numbers with {proposal.by}, you do not know that the
          person asking you to sign is who your screen says they are. */}
      {!verified && proposal.by !== me && (
        <button className="signing-unchecked" data-testid="signing-compare" onClick={onCompare}>
          <AlertTriangle size={14} />
          <span>
            <strong>You haven&rsquo;t compared numbers with {proposal.by}</strong>
            <span className="muted">
              They&rsquo;re vouching for {proposal.handle}. Check they&rsquo;re who your
              screen says before you take their word for it.
            </span>
          </span>
          <span className="signing-compare-go">compare</span>
        </button>
      )}

      <section className="signing-section">
        <h3 className="overline">what your signature does</h3>
        {/* Plainly, and before the button rather than after it. §11.2: what
            is true, what it means for you, what to do about it. */}
        <ul className="signing-consequences">
          <li>
            {proposal.handle} gets everything the circle keeps — all{' '}
            {rooms.length === 1 ? 'one room' : `${rooms.length} rooms`}, back to the first
            message anyone sent.
          </li>
          <li>
            If they leave later, new messages close to them. What they already read stays
            with them.
          </li>
          {clearing.length > 0 && (
            <li>
              #{clearing[0]} clears itself, so they will see very little of it.
            </li>
          )}
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
            <span>why not?</span>
            <input
              autoFocus
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              data-testid="signing-object-why"
            />
          </label>
          <p className="fineprint muted">
            An objection stays on the proposal and {proposal.by} sees it. It doesn&rsquo;t
            cancel the count on its own.
          </p>
          <div className="row">
            <button className="button danger" disabled={!why.trim()} data-testid="signing-object-post">
              object
            </button>
            <button type="button" className="button" onClick={() => setObjecting(false)}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="signing-actions">
          {/* §10.4 — equal weight, and neither is coral.
              §1.1 reserves coral for "the one primary action in view", and
              this screen has no primary action: it has one question with two
              answers, and picking either is a complete use of the screen.
              Red is not on the objecting one either — §1.4 spends red on
              broken or irreversible, and objecting is neither. Signing is
              the irreversible half, which is what the consequence list
              above the buttons is for. So both are plain, the same size,
              and told apart by their glyph and their words (§1.6). */}
          <button
            className="button signing-answer"
            disabled={mine}
            data-testid="signing-sign"
            onClick={onSign}
          >
            <Check size={14} />
            {mine ? 'you have answered' : `sign for ${proposal.handle}`}
          </button>
          <button
            className="button signing-answer"
            disabled={mine}
            data-testid="signing-object"
            onClick={() => setObjecting(true)}
          >
            <X size={14} />
            object, and say why
          </button>
        </div>
      )}

      <p className="signing-foot">
        <ShieldCheck size={14} />
        <span>
          {proposal.by === me ? 'You' : proposal.by} can&rsquo;t do this alone, and neither can
          you. That&rsquo;s the whole reason this screen exists.
          {/* §10.7's shape: say what is enforcing this, and by what. */}
          <span className="fineprint muted">
            Every signature here is signed by its author and every member sees the same
            ledger. The relay still asks an admin to run the change itself — so this is what
            the circle agreed, not something the mathematics refuses to do otherwise.
          </span>
        </span>
      </p>

      {/* §7.3 — withdrawing takes the whole proposal down, so it sits well
          clear of the two answers above rather than beside them. */}
      {canWithdraw(proposal, me, server.roles?.[me] === 'admin') && (
        <button className="signing-withdraw" data-testid="signing-withdraw" onClick={onWithdraw}>
          withdraw this proposal
        </button>
      )}
      {onClose && (
        <button className="button signing-close" data-testid="signing-close" onClick={onClose}>
          back
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
