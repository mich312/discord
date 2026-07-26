import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, CircleGlyph } from './icons.jsx';
import { MIN_QUERY } from '../lib/search.js';

// Long enough that typing a word does not fire a full scan per keystroke,
// short enough that pausing feels like the results were already there.
const DEBOUNCE_MS = 160;

// ⌘K switcher. Rooms across every circle, circle switching, the handful of
// global actions — and, below them, the messages themselves: search has to
// live somewhere, and a second surface for it would be a worse answer than
// the one keystroke people already press.
export default function CommandPalette({ servers, active, actions, onSearch, onNavigate, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [found, setFound] = useState({ hits: [], truncated: false, for: '' });
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Debounced, and every in-flight scan is fenced by the query it was for:
  // a slow scan resolving after a faster later one must not overwrite it.
  const q = query.trim();
  useEffect(() => {
    if (!onSearch || q.length < MIN_QUERY) {
      setSearching(false);
      setFound({ hits: [], truncated: false, for: '' });
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      Promise.resolve(onSearch(q))
        .then((r) => alive && setFound({ ...r, for: q }))
        .catch(() => alive && setFound({ hits: [], truncated: false, for: q }))
        .finally(() => alive && setSearching(false));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, onSearch]);

  const items = useMemo(() => {
    const rooms = servers.flatMap((s) =>
      s.channels.map((ch) => ({
        id: `room:${s.id}:${ch}`,
        label: ch,
        hint: s.name,
        glyph: <Hash />,
        run: () => onNavigate(s.id, ch),
      }))
    );
    const circles = servers.map((s) => ({
      id: `circle:${s.id}`,
      label: s.name,
      hint: s.id === active ? 'current circle' : 'circle',
      glyph: <CircleGlyph />,
      run: () => onNavigate(s.id, null), // land on the circle's home base
    }));
    const all = [...rooms, ...circles, ...actions];
    const needle = query.trim().toLowerCase();
    const jump = needle
      ? all.filter(
          (it) =>
            it.label.toLowerCase().includes(needle) || (it.hint ?? '').toLowerCase().includes(needle)
        )
      : all;

    // Message hits go last: navigation is what the palette is for, and a
    // busy circle would otherwise bury the room you were reaching for.
    // Only the hits for the query currently in the box — stale results from
    // a previous word are worse than none.
    const messages =
      found.for === query.trim()
        ? found.hits.map((h, i) => ({
            id: `msg:${h.server}:${h.channel}:${h.ts}:${i}`,
            label: `${h.sender}: `,
            snippet: h.snippet,
            hint: `${h.serverName ?? h.server} · #${h.channel}`,
            glyph: <Hash />,
            // Opening the room is as precise as this can be: there is no
            // deep link to a message, and jumping to one would need a
            // scroll anchor the message list does not have.
            run: () => onNavigate(h.server, h.channel),
          }))
        : [];

    return [...jump, ...messages];
  }, [servers, active, actions, query, found, onNavigate]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  function onKeyDown(e) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && items[index]) {
      e.preventDefault();
      items[index].run();
      onClose();
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a room, or search your messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {items.length === 0 ? (
          <div className="palette-empty">
            {searching ? `searching your messages for “${query}”…` : `nothing matches “${query}”`}
          </div>
        ) : (
          <ul className="palette-results" ref={listRef}>
            {items.map((it, i) => (
              <li key={it.id}>
                <button
                  className={i === index ? 'palette-item selected' : 'palette-item'}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => {
                    it.run();
                    onClose();
                  }}
                >
                  <span className="glyph">{it.glyph}</span>
                  {it.label}
                  {it.snippet && (
                    <span className="palette-snippet">
                      {it.snippet.before}
                      <mark>{it.snippet.match}</mark>
                      {it.snippet.after}
                    </span>
                  )}
                  <span className="hint">{it.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {found.truncated && found.for === query.trim() && (
          <div className="palette-note">
            showing the most recent matches only — narrow the search to see older ones
          </div>
        )}
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> dismiss</span>
          {/* The honest limit, stated where it matters rather than in a
              README nobody opens: the relay holds ciphertext and cannot
              index it, so search sees only this device's own copies. */}
          <span className="palette-scope">search covers this device only</span>
        </div>
      </div>
    </div>
  );
}
