// Native View Transitions — the "fancy" motion (channel cross-fades, roster
// FLIP, text⇄call-stage morph) with ZERO runtime dependency. It's a browser
// API driven entirely by CSS ::view-transition-* pseudo-elements, so it costs
// nothing in the bundle and adds nothing to trust under the app's strict CSP
// (no eval, nothing to self-host or SRI). Where the API is missing or the user
// asked for reduced motion, every path here degrades to an instant, correct cut.
import { flushSync } from 'react-dom';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Whether a real transition should run right now. */
export function canViewTransition() {
  return (
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    !prefersReducedMotion()
  );
}

/** Run a React state update inside a View Transition when supported, else
    apply it plainly. flushSync forces the DOM to reflect the update before
    the browser snapshots the "after" frame — without it, React's async commit
    would land after the snapshot and nothing would animate. */
export function withViewTransition(update) {
  if (!canViewTransition()) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

/** A stable, valid view-transition-name for a member handle, so a row keeps
    its identity as it moves between roster groups and the browser slides it
    (FLIP) instead of cross-dissolving. Prefixed so it never starts with a
    digit; non-ident chars collapse to '-'. */
export function memberVtName(handle) {
  return `vt-m-${String(handle).replace(/[^a-zA-Z0-9]+/g, '-')}`;
}
