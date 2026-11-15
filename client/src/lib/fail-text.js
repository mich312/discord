// What a failed action says on screen. The app's own errors are sentences
// written for the user (capital letter, full stop) and pass through;
// anything else is a browser, worker or relay internal ("This is an invalid
// domain.", a WebAuthn spec URL), so the caller's short `fallback` is shown.

export const TRY_AGAIN = 'That didn’t work. Try again.';

/** A prompt the user closed (passkey sheet, screen picker) is not a failure. */
export const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';

/** The text to show for `e`, or `fallback` when its message is not ours. */
export function failText(e, fallback = TRY_AGAIN) {
  const msg = typeof e?.message === 'string' ? e.message.trim() : '';
  if (msg && (e.user || (e.name === 'Error' && /^[A-Z][\s\S]*[.?]$/.test(msg)))) return msg;
  return fallback;
}

/** As failText, but null for a cancelled prompt, so nothing is shown. */
export const errorText = (e, fallback = TRY_AGAIN) => (cancelled(e) ? null : failText(e, fallback));
