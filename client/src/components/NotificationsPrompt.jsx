import { useDialog } from '../lib/useDialog.js';
import React, { useEffect, useState } from 'react';
import { Bell, X } from './icons.jsx';
import { failText } from '../lib/fail-text.js';

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
      setError(failText(e, 'Notifications are off. You can turn them on in Settings.'));
      setBusy(false);
    }
  }

  const dialog = useDialog(onClose, { label: 'Turn on notifications' });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal notif-prompt"
        ref={dialog.ref}
        {...dialog.props}
        onClick={(e) => e.stopPropagation()}
        data-testid="notif-prompt"
      >
        <div className="dialog-head">
          <h1>Turn on notifications?</h1>
        </div>
        {/* True to sw.js: the body names the circle, never the sender or text. */}
        <p className="muted lede">Notifications show the circle name, never the message.</p>
        <button
          className="button primary wide"
          disabled={busy}
          data-testid="notif-prompt-enable"
          onClick={enable}
        >
          <Bell size={14} />
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          className="button wide"
          disabled={busy}
          data-testid="notif-prompt-dismiss"
          onClick={onClose}
        >
          Not now
        </button>
        {error && <p className="fineprint warn" data-testid="notif-prompt-error">{error}</p>}
        <button className="ghost close" onClick={onClose} data-testid="notif-prompt-close" aria-label="Close" title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
