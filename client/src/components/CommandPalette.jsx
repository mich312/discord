import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, CircleGlyph, ArrowRight } from './icons.jsx';

// ⌘K switcher. Rooms across every circle, circle switching, and the
// handful of global actions — one keystroke away, keyboard-first.
export default function CommandPalette({ servers, active, actions, onNavigate, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

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
      hint: s.id === active ? 'current circle — game hub' : 'circle game hub',
      glyph: <CircleGlyph />,
      run: () => onNavigate(s.id, null), // land on the circle's home base
    }));
    const all = [...rooms, ...circles, ...actions];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (it) => it.label.toLowerCase().includes(q) || (it.hint ?? '').toLowerCase().includes(q)
    );
  }, [servers, active, actions, query, onNavigate]);

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
          placeholder="Jump to a room, a circle, or an action…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {items.length === 0 ? (
          <div className="palette-empty">nothing matches “{query}”</div>
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
                  <span className="hint">{it.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> dismiss</span>
          <span className="push-right"><ArrowRight size={12} /> everything stays sealed</span>
        </div>
      </div>
    </div>
  );
}
