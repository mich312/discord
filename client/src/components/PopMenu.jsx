import React, { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/cx.js';

// A small button that opens a short list of actions. Closes on a pick, on
// Escape (focus returns to the button) and on a tap anywhere else.
export default function PopMenu({ label, glyph, testid, items, className }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector('[role="menuitem"]')?.focus();
    const away = (e) => {
      if (!wrap.current?.contains(e.target)) setOpen(false);
    };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  // Arrow keys move between items, as in any menu.
  const step = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(list.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <span className={cx('pop-menu-wrap', className)} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="ghost"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testid}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </button>
      {open && (
        <span className="pop-menu" role="menu" aria-label={label} ref={list} onKeyDown={step}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={cx('pop-menu-item', it.danger && 'danger')}
              data-testid={it.testid}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
