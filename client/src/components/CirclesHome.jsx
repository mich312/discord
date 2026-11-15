import React, { useState } from 'react';
import CircleMark from './CircleMark.jsx';
import Seal from './Seal.jsx';
import { Plus, Key, ShieldCheck, Hash, Wave, Clock } from './icons.jsx';
import { circlePresence } from '../lib/presence.js';
import { describeUntil, soonestEvent } from '../lib/overview.js';
import { decisionsFor } from '../lib/quorum.js';

// Every circle you are in: who is there now, what is next, what moved since
// you last looked. Proposals waiting on you sit above the cards, because
// letting somebody in is the one irreversible thing the product does.

function memberLine(n) {
  return `${n} member${n === 1 ? '' : 's'}`;
}

function CircleCard({ server, me, voice, unread, now, onOpen }) {
  const { inRoom, playing, live } = circlePresence(server, voice, now);
  const next = soonestEvent(server.overview, now);
  const blurb = server.overview?.blurb ?? '';
  // Which call, if any — a card that says "3 here now" should say where.
  const room = Object.values(inRoom)[0] ?? null;

  return (
    <article className="circle-card">
      <header className="circle-card-head">
        <CircleMark id={server.id} name="" glyph={server.overview?.glyph} size={44} />
        <div className="circle-card-id">
          {/* The whole card opens the circle: this button's hit area is
              stretched over the card (.circle-card-open::after). */}
          <h3>
            <button
              type="button"
              className="circle-card-open"
              data-testid={`circles-open-${server.id}`}
              onClick={onOpen}
            >
              {server.name}
            </button>
          </h3>
          {blurb ? <p className="circle-card-blurb">{blurb}</p> : null}
        </div>
      </header>

      <ul className="circle-card-facts">
        <li>
          {/* §1.2/§1.6 — green is "someone is here right now", and it never
              travels without the words that say so. */}
          {live.length > 0 ? (
            <span className="circle-card-live" data-testid={`circles-live-${server.id}`}>
              <span className="circle-card-orbs">
                {live.slice(0, 4).map((m) => (
                  <Seal key={m} name={m} size={22} title={m} />
                ))}
              </span>
              <span className="circle-card-live-word">
                {room ? (
                  <>
                    {live.length} in <Wave size={14} /> {room}
                  </>
                ) : (
                  `${live.length} playing`
                )}
              </span>
            </span>
          ) : (
            <span className="circle-card-quiet">
              {memberLine(server.members?.length ?? 0)}
            </span>
          )}
        </li>

        {next && (
          <li className="circle-card-next">
            <Clock size={14} />
            <span className="circle-card-next-title">{next.title}</span>
            <span className="circle-card-when">{describeUntil(next.at, now)}</span>
          </li>
        )}

        {unread > 0 && (
          <li className="circle-card-catchup" data-testid={`circles-unread-${server.id}`}>
            <Hash size={14} />
            <span>
              {unread} unread
            </span>
          </li>
        )}
      </ul>
    </article>
  );
}

export default function CirclesHome({
  servers,
  loading,
  me,
  voice,
  unreads,
  now = Date.now(),
  onOpen,
  onCreate,
  onOpenProposal,
  onIdentity,
  onSecure,
  // False while the unsecured banner is up: it already offers the fix.
  showAccountActions = true,
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const total = servers.length;
  // "No circles yet" is a claim we cannot make while they are still loading.
  const empty = !loading && total === 0;
  const decisions = decisionsFor(servers, me);

  return (
    <div className="circles-home" data-testid="circles-home">
      <header className="circles-head">
        <div className="circles-head-id">
          {/* §8.8 — the one h1 while no circle is open. */}
          <h1>Your circles</h1>
          {empty && (
            <p className="muted">
              No circles yet. Share your handle: <strong>{me}</strong>
            </p>
          )}
        </div>
        {/* Settings has both; here only for an empty account. */}
        {empty && showAccountActions && (
          <div className="circles-head-actions">
            <button className="button" data-testid="identity-open-empty" onClick={onIdentity}>
              <Key size={14} />
              Identity key
            </button>
            <button className="button" data-testid="secure-open-empty" onClick={onSecure}>
              <ShieldCheck size={14} />
              Back up account
            </button>
          </div>
        )}
      </header>

      {decisions.length > 0 && (
        <section className="circles-decisions" data-testid="circles-decisions">
          <h2 className="overline">Needs you</h2>
          {decisions.map(({ server, proposal, signed, threshold }) => {
            const togo = Math.max(0, threshold - signed);
            return (
              <button
                className="decision-row"
                key={`${server.id}:${proposal.id}`}
                data-testid={`decision-${proposal.id}`}
                onClick={() => onOpenProposal?.(server.id, proposal.id)}
              >
                <Seal name={proposal.handle} size={26} title={proposal.handle} />
                <span className="decision-text">
                  {/* The sentence the design asks for, and it is a sentence
                      rather than a badge because the number on its own
                      ("1/3") does not say what happens when it lands. */}
                  <strong>{proposal.handle}</strong>{' '}
                  {togo === 0
                    ? 'has the signatures to join'
                    : togo === 1
                      ? 'needs one more signature to join'
                      : `needs ${togo} more signatures to join`}{' '}
                  <span className="decision-circle">{server.name}</span>
                </span>
                <span className="button primary decision-go" aria-hidden="true">
                  Review
                </span>
              </button>
            );
          })}
        </section>
      )}

      {loading && total === 0 ? (
        <p className="circles-placeholder" role="status" data-testid="circles-loading-row">
          Loading…
        </p>
      ) : (
        <div className="circle-cards">
          {servers.map((s) => (
            <CircleCard
              key={s.id}
              server={s}
              me={me}
              voice={voice}
              unread={unreads?.[s.id] ?? 0}
              now={now}
              onOpen={() => onOpen(s.id)}
            />
          ))}
        </div>
      )}

      <footer className="circles-foot">
        {adding ? (
          <form
            className="circles-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onCreate(name.trim());
              setName('');
              setAdding(false);
            }}
          >
            {/* §8.7 — a real label, not a placeholder standing in for one. */}
            <label className="field">
              <span>Circle name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-server-name"
              />
            </label>
            <button className="button primary" data-testid="new-server-create">
              Create
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setName('');
                setAdding(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button className="circles-new-btn" data-testid="new-server" onClick={() => setAdding(true)}>
            <Plus size={18} />
            <strong>New circle</strong>
          </button>
        )}
      </footer>
    </div>
  );
}
