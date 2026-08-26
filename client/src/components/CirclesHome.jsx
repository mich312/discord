import React, { useState } from 'react';
import CircleMark from './CircleMark.jsx';
import Seal from './Seal.jsx';
import { Plus, Key, ShieldCheck, Hash, Wave, Clock } from './icons.jsx';
import { circlePresence } from '../lib/presence.js';
import { describeUntil, soonestEvent } from '../lib/overview.js';
import { decisionsFor } from '../lib/quorum.js';

// What replaces the rail.
//
// The rail was sixty pixels of monogram tiles carrying, per circle, one fact:
// whether it had unread messages. It was permanent chrome for a decision
// people make a few times a day, and the decision it supported was the wrong
// one — "which circle" is not "which tile", it is "which of these has
// something I should look at".
//
// So crossing between circles gets a screen instead of a strip, and the
// screen has room to answer the real question: who is in there right now,
// what is next, and what has moved since you last looked. Three circles fit
// on it without scrolling, which is the number a person is actually in.
//
// Above the cards sits the one thing on this screen that is not "pick a
// room to go to": the decisions waiting on you. A proposal to let somebody
// into a circle is the only irreversible thing the product does, and it can
// sit unanswered in a circle you had no other reason to open today — so it
// comes to the screen you land on rather than waiting to be found.

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
          <h3>{server.name}</h3>
          {/* No fallback here. The facts row below already carries the member
              count, and a card that says "2 members" twice reads as a bug. */}
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
                  <Seal key={m} name={m} size={22} title={m === me ? 'you' : m} />
                ))}
              </span>
              <span className="circle-card-live-word">
                {live.length} of {server.members?.length ?? 0} here now
                {room ? (
                  <>
                    {' '}
                    in <Wave size={14} /> {room}
                  </>
                ) : (
                  ' — in a game'
                )}
              </span>
            </span>
          ) : (
            <span className="circle-card-quiet">
              {memberLine(server.members?.length ?? 0)} · nobody here right now
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
              {unread} you haven&rsquo;t read
            </span>
          </li>
        )}
      </ul>

      <button className="button primary" data-testid={`circles-open-${server.id}`} onClick={onOpen}>
        open
      </button>
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
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const total = servers.length;
  // Everyone who can read something of yours, counted once. "Seventeen people
  // who know you're in them" is the claim worth making on this screen: the
  // roster *is* the security boundary, and this is the only place the whole
  // of it is in view.
  const reach = new Set(servers.flatMap((s) => s.members ?? []).filter((m) => m !== me)).size;
  const decisions = decisionsFor(servers, me);

  return (
    <div className="circles-home" data-testid="circles-home">
      <header className="circles-head">
        <Seal name={me} size={44} title={me} />
        <div className="circles-head-id">
          {/* §8.8 — the document has exactly one h1 at a time, and with no
              circle open the marker that usually carries it is not on screen.
              This page had no h1 at all. */}
          <h1>Your circles</h1>
          {loading ? (
            // "You are in no circles" is a claim, and while they are still
            // being fetched it is one we cannot make.
            <p className="muted" data-testid="circles-loading">
              They live on the relay, encrypted — fetching them now. Signed in as{' '}
              <strong>{me}</strong>
            </p>
          ) : total > 0 ? (
            <p className="muted">
              {total} circle{total === 1 ? '' : 's'}
              {reach > 0 && ` · ${reach} ${reach === 1 ? 'person' : 'people'} who know you're in them`}
            </p>
          ) : (
            <p className="muted">
              Start one below, follow an invite link, or ask someone to add you — they need
              your handle: <strong>{me}</strong>
            </p>
          )}
        </div>
        <div className="circles-head-actions">
          <button className="button" data-testid="identity-open-empty" onClick={onIdentity}>
            <Key size={14} />
            identity key
          </button>
          <button className="button" data-testid="secure-open-empty" onClick={onSecure}>
            <ShieldCheck size={14} />
            secure account
          </button>
        </div>
      </header>

      {decisions.length > 0 && (
        <section className="circles-decisions" data-testid="circles-decisions">
          <span className="overline">waiting on you</span>
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
                      ? 'is one signature short of joining'
                      : `needs ${togo} more signatures to join`}{' '}
                  <span className="decision-circle">{server.name}</span>
                </span>
                <span className="mono">read it</span>
              </button>
            );
          })}
        </section>
      )}

      {loading && total === 0 ? (
        <p className="circles-placeholder" role="status" data-testid="circles-loading-row">
          Loading your circles…
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
              <span>circle name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-server-name"
              />
            </label>
            <button className="button primary" data-testid="new-server-create">
              start it
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setName('');
                setAdding(false);
              }}
            >
              cancel
            </button>
          </form>
        ) : (
          <button className="circles-new-btn" data-testid="new-server" onClick={() => setAdding(true)}>
            <Plus size={18} />
            <span>
              <strong>Start a circle</strong>
              {/* §11.10 — an empty state names the next action and who can
                  take it. You can; nobody has to approve it. */}
              <span className="muted">you pick who is in it, and it is yours to invite to</span>
            </span>
          </button>
        )}
      </footer>
    </div>
  );
}
