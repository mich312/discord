import React, { useState } from 'react';
import Seal from './Seal.jsx';
import { Hash, Wave, Lock, LinkGlyph, Plus, X, ArrowRight, Clock } from './icons.jsx';

// The circle's landing zone: what you see when you pick a circle, before
// any room. A cover page the group writes for itself — blurb and pinned
// links — plus a live directory of rooms and voice tables. Like every
// name and topic here, the content travels inside the MLS encryption;
// the relay never learns what a circle says about itself.
//
// Editing is admin-gated in the UI (same advisory model as channel
// settings) and every change is announced in #general.

// Only ever link out to http(s) — anything else renders as inert text, so
// a pinned "javascript:" or "data:" URL can't become a click target.
function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

function EditForm({ overview, onSave, onCancel }) {
  const [blurb, setBlurb] = useState(overview?.blurb ?? '');
  const [links, setLinks] = useState(overview?.links ?? []);

  const setLink = (i, patch) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form
      className="overview-edit-form"
      data-testid="overview-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ blurb: blurb.trim(), links });
      }}
    >
      {/* the section's "about" overline already titles this field */}
      <textarea
        aria-label="about this circle"
        data-testid="overview-blurb-input"
        rows={5}
        value={blurb}
        onChange={(e) => setBlurb(e.target.value)}
        placeholder={'What is this circle for? House rules, cadence, where to start…'}
      />
      <label className="overview-field-label">pinned links</label>
      {links.map((l, i) => (
        <div className="overview-link-edit" key={i}>
          <input
            value={l.label}
            onChange={(e) => setLink(i, { label: e.target.value })}
            placeholder="label"
            data-testid={`overview-link-label-${i}`}
          />
          <input
            value={l.url}
            onChange={(e) => setLink(i, { url: e.target.value })}
            placeholder="https://…"
            data-testid={`overview-link-url-${i}`}
          />
          <button
            type="button"
            className="ghost"
            title="remove link"
            onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost overview-add-link"
        data-testid="overview-add-link"
        onClick={() => setLinks((ls) => [...ls, { label: '', url: '' }])}
      >
        <Plus size={12} />
        add a link
      </button>
      <div className="row overview-edit-actions">
        <button className="button primary" type="submit" data-testid="overview-save">
          save overview
        </button>
        <button className="button" type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
      <p className="fineprint muted">
        Everyone in the roster sees this page. Links open only if they start with
        https:// — everything else stays plain text.
      </p>
    </form>
  );
}

export default function Overview({ server, canManage, voice, onSelectChannel, onVoiceJoin, onSave }) {
  const [editing, setEditing] = useState(false);
  const overview = server.overview ?? null;
  const rooms = server.channels;
  const voiceRooms = server.voiceChannels ?? ['lounge'];
  const keptHistory = rooms.filter((ch) => server.chanMeta?.[ch]?.hid).length;

  return (
    <main className="messages-pane overview-pane" data-testid="overview-pane">
      <header className="pane-head">
        <span className="room-name">
          <span className="glyph">
            <Lock size={13} />
          </span>
          overview
        </span>
        <span className="sealed-note">
          the circle&rsquo;s landing page — sealed like everything else, the relay never reads it
        </span>
      </header>
      <div className="scroll overview-scroll">
        <section className="overview-hero">
          <Seal name={server.name} size={56} title={server.name} />
          <div className="overview-title">
            <h2 data-testid="overview-name">{server.name}</h2>
            <div className="overview-stats mono">
              <span>{server.members.length} member{server.members.length === 1 ? '' : 's'}</span>
              <span>·</span>
              <span>{rooms.length} room{rooms.length === 1 ? '' : 's'}</span>
              <span>·</span>
              <span>epoch {String(server.epoch).padStart(2, '0')}</span>
              {keptHistory > 0 && (
                <>
                  <span>·</span>
                  <span>{keptHistory} keep{keptHistory === 1 ? 's' : ''} history</span>
                </>
              )}
            </div>
          </div>
          {canManage && !editing && (
            <button
              className="button overview-customize"
              data-testid="overview-edit"
              onClick={() => setEditing(true)}
            >
              customize
            </button>
          )}
        </section>

        <section className="overview-section">
          <span className="overline">about</span>
          {editing ? (
            <EditForm
              overview={overview}
              onSave={(ov) => {
                setEditing(false);
                onSave(ov);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : overview?.blurb ? (
            <p className="overview-blurb" data-testid="overview-blurb">
              {overview.blurb}
            </p>
          ) : (
            <p className="overview-blurb placeholder muted" data-testid="overview-blurb-empty">
              {canManage
                ? 'Nothing here yet — use customize to tell the circle what this place is for.'
                : 'The admins have not written anything here yet.'}
            </p>
          )}
        </section>

        {!editing && (overview?.links?.length ?? 0) > 0 && (
          <section className="overview-section">
            <span className="overline">pinned links</span>
            <ul className="overview-links">
              {overview.links.map((l, i) => {
                const href = safeHref(l.url);
                return (
                  <li key={i}>
                    {href ? (
                      <a
                        className="overview-link"
                        data-testid="overview-link"
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <LinkGlyph size={13} />
                        <span className="label">{l.label || l.url}</span>
                        <span className="url mono">{l.url}</span>
                      </a>
                    ) : (
                      <span className="overview-link inert" data-testid="overview-link" title="not an https:// link — shown, never opened">
                        <LinkGlyph size={13} />
                        <span className="label">{l.label || l.url}</span>
                        <span className="url mono">{l.url}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="overview-section">
          <span className="overline">rooms</span>
          <ul className="overview-rooms">
            {rooms.map((ch) => {
              const meta = server.chanMeta?.[ch] ?? {};
              return (
                <li key={ch}>
                  <button
                    className="overview-room"
                    data-testid={`overview-room-${ch}`}
                    onClick={() => onSelectChannel(ch)}
                  >
                    <span className="glyph">
                      <Hash size={13} />
                    </span>
                    <span className="room">{ch}</span>
                    {meta.topic && <span className="topic">{meta.topic}</span>}
                    {meta.retention ? (
                      <span className="chan-flag" title="auto-delete is on">
                        <Clock size={11} />
                      </span>
                    ) : null}
                    <span className="go">
                      <ArrowRight size={12} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="overview-section">
          <span className="overline">voice</span>
          <ul className="overview-rooms">
            {voiceRooms.map((ch) => {
              const present = voice?.presence?.[`${server.id}/${ch}`] ?? [];
              return (
                <li key={ch}>
                  <button
                    className="overview-room"
                    data-testid={`overview-voice-${ch}`}
                    onClick={() => onVoiceJoin(ch)}
                    title={`join "${ch}"`}
                  >
                    <span className="glyph">
                      <Wave size={13} />
                    </span>
                    <span className="room">{ch}</span>
                    {present.length > 0 && (
                      <span className="topic">{present.join(', ')}</span>
                    )}
                    <span className="go mono">join</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <p className="fineprint muted overview-foot">
          Everything on this page — the name, the words, the links — exists only inside
          the encryption. {server.members.length} device{server.members.length === 1 ? '' : 's'} can
          read it; the relay is not one of them.
        </p>
      </div>
    </main>
  );
}
