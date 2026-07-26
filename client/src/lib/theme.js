// Theme resolution.
//
// Three states, not two. `pref` is 'paper' | 'carbon' | null, where null means
// "follow the operating system" — the state a fresh install starts in. The
// rest of the UI never sees null; it gets the *resolved* theme and stays a
// simple two-way toggle.
//
// The first paint is handled entirely in CSS (`prefers-color-scheme` on
// `:root:not([data-theme])` in styles.css). Nothing here runs early enough to
// prevent a flash, and the CSP forbids the inline head script that would —
// so JavaScript's job is only to apply an *explicit* choice and to keep the
// theme-color meta in step.

export const STORAGE_KEY = 'quorum-theme';

// Matches the --well token of each palette, so the browser/OS chrome
// (Android address bar, iOS standalone status bar) meets the app surface
// without a seam. Keep in sync with styles.css.
export const THEME_COLOR = { paper: '#e9e6e0', carbon: '#09090a' };

/**
 * Read the stored preference. Anything unrecognised is treated as "no
 * preference" rather than as dark: an unreadable value should not silently
 * pin a theme the user never chose.
 *
 * Existing installs are unaffected by the move to a system default. The old
 * code wrote the resolved theme back on every mount, so anyone who has run
 * this app before already has an explicit 'paper' or 'carbon' stored, and
 * keeps exactly the theme they had. Only genuinely fresh profiles follow the
 * system.
 *
 * ('vellum' is accepted for continuity with the previous theme naming.)
 */
export function readPref(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(STORAGE_KEY);
    if (v === 'paper' || v === 'vellum') return 'paper';
    if (v === 'carbon') return 'carbon';
    return null;
  } catch {
    // Private mode, disabled storage, cross-origin restrictions. Follow the
    // system for this session; the toggle still works, it just won't persist.
    return null;
  }
}

/** Persist a choice. Returns false if storage refused — the caller keeps the
 *  in-memory state either way, so the toggle works even in private mode. */
export function writePref(pref, storage = globalThis.localStorage) {
  try {
    if (pref === null) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, pref);
    return true;
  } catch {
    return false;
  }
}

/** The theme actually shown: an explicit preference, or the system's. */
export function resolveTheme(pref, prefersLight) {
  if (pref === 'paper' || pref === 'carbon') return pref;
  return prefersLight ? 'paper' : 'carbon';
}

/** Does the OS ask for a light UI? False wherever the query is unsupported,
 *  which keeps the historical dark default for those browsers. */
export function prefersLight(mm = globalThis.matchMedia) {
  try {
    return mm?.('(prefers-color-scheme: light)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to OS theme changes. Calls `onChange(prefersLight)` when the
 * system flips. Returns an unsubscribe function (a no-op where unsupported).
 */
export function watchSystem(onChange, mm = globalThis.matchMedia) {
  let q;
  try {
    q = mm?.('(prefers-color-scheme: light)');
  } catch {
    return () => {};
  }
  if (!q?.addEventListener) return () => {};
  const handler = (e) => onChange(e.matches === true);
  q.addEventListener('change', handler);
  return () => q.removeEventListener('change', handler);
}
