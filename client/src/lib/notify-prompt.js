// First-run notifications ask: the plumbing to turn push on has always lived
// in Settings, but nobody digs through Settings on day one — so we surface a
// one-time prompt right after landing. This module is the pure decision half
// (unit-tested), kept out of the component so the "when" is testable without a
// DOM.

// Set once the user has answered the prompt either way (enabled or dismissed).
// A permanent flag: the prompt is a nicety, not a nag — Settings stays the
// place to change your mind afterwards.
export const NOTIF_PROMPTED_KEY = 'quorum-notif-prompted';

// Whether to surface the first-run notifications prompt.
//   supported  — the browser exposes the Notification API at all
//   permission — Notification.permission ('default' | 'granted' | 'denied')
//   asked      — we've already prompted this device (persisted flag)
// We only ask when there's a real decision to offer: the API exists, the user
// hasn't already granted or blocked it, and we haven't asked before. 'granted'
// needs no prompt; 'denied' can't be undone from script, so re-asking is noise.
export function shouldPromptNotifications({ supported, permission, asked }) {
  if (!supported) return false;
  if (asked) return false;
  return permission === 'default';
}

// Read the persisted flag without throwing where storage is unavailable
// (private mode, blocked cookies) — a missing store just means "not asked".
export function notifAlreadyPrompted() {
  try {
    return !!localStorage.getItem(NOTIF_PROMPTED_KEY);
  } catch {
    return false;
  }
}

// Remember that we've asked, so the prompt never reappears on later loads.
export function markNotifPrompted() {
  try {
    localStorage.setItem(NOTIF_PROMPTED_KEY, '1');
  } catch {
    /* storage blocked — worst case the prompt shows again next session */
  }
}
