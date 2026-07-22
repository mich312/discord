import React, { useEffect, useState } from 'react';
import { Bell, Check, X } from './icons.jsx';

// First-run nudge to turn on push notifications, shown once shortly after you
// land in the app. The actual permission request fires from the "enable"
// button (a real user gesture, which browsers require), routing through the
// same controller.enableNotifications() that Settings uses. "not now" just
// closes it — Settings stays the place to turn them on later.
export default function NotificationsPrompt({ onEnable, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Escape dismisses, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await onEnable();
      onClose(); // success — dismiss and don't ask again
    } catch (e) {
      // Most often the permission dialog was denied. The decision is now made
      // either way, so surface why and let them close it; we won't re-nag.
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal notif-prompt"
        onClick={(e) => e.stopPropagation()}
        data-testid="notif-prompt"
      >
        <div className="dialog-head">
          <span className="dialog-glyph"><Bell size={18} /></span>
          <h1>Turn on notifications?</h1>
        </div>
        <p className="muted lede">
          Get a nudge when a message arrives while quorum is closed. Only the fact
          that something happened is pushed — never who, where, or what. Like
          everything else, the contents stay sealed on your device.
        </p>
        <button
          className="button primary wide"
          disabled={busy}
          data-testid="notif-prompt-enable"
          onClick={enable}
        >
          <Bell size={14} />
          {busy ? 'enabling…' : 'enable notifications'}
        </button>
        <button
          className="button wide"
          disabled={busy}
          data-testid="notif-prompt-dismiss"
          onClick={onClose}
        >
          not now
        </button>
        {error ? (
          <p className="fineprint warn" data-testid="notif-prompt-error">{error}</p>
        ) : (
          <p className="fineprint muted">
            You can change this anytime in Settings.
          </p>
        )}
        <button className="ghost close" onClick={onClose} data-testid="notif-prompt-close" title="close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
