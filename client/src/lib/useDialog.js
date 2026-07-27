import { useEffect, useRef } from 'react';

/** The ARIA contract an overlay must carry. Pure and exported separately so
    it can be asserted without a React renderer. */
export function dialogProps(label) {
  return {
    role: 'dialog',
    'aria-modal': 'true',
    ...(label ? { 'aria-label': label } : {}),
    // Focusable so the dialog itself can hold focus when it has no controls,
    // and so the keydown handler always has a target.
    tabIndex: -1,
  };
}

/** Focus management for a modal overlay.

    None of the overlays had any: they rendered a bare `<div className=
    "modal-backdrop">`, so a screen reader announced nothing, Tab walked
    straight out of the dialog into the app behind it, and closing left focus
    on whatever the browser fell back to. With a modal open the app was not
    keyboard-usable at all.

    Returns a ref for the dialog element. Attach it and spread the returned
    props onto that element:

      const { ref, props } = useDialog(onClose);
      <div className="modal-backdrop" onClick={onClose}>
        <div className="card modal" ref={ref} {...props} onClick={stop}>

    Escape closes, focus moves in on open and back to the opener on close,
    and Tab cycles within the dialog. */
export function useDialog(onClose, { label } = {}) {
  const ref = useRef(null);
  // Captured on mount so focus can go back where it came from, which is
  // what makes a dialog feel like it belongs to the control that opened it.
  const opener = useRef(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const node = ref.current;
    if (!node) return undefined;

    // `tabindex="-1"` has to be excluded on every element type, not just on
    // the bare [tabindex] arm. A listbox option is a real <button> that is
    // deliberately not a tab stop, and counting it made the trap believe the
    // last option was the edge — so on Tab from the input it declined to
    // intervene, and the browser, which does respect tabindex="-1", moved
    // focus out of the dialog entirely.
    const focusable = () =>
      [
        ...node.querySelectorAll(
          'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Prefer the first real control; fall back to the dialog itself so focus
    // is never left outside.
    const first = focusable()[0];
    (first ?? node).focus?.();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      // Only intervene at the edges; inside the list the browser's own
      // ordering is what we want.
      if (document.activeElement === edge || !node.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // Restore focus, but only if it is still somewhere in this dialog —
      // if something else deliberately took it, leave it alone.
      if (!node.contains(document.activeElement) && document.activeElement !== document.body) {
        return;
      }
      opener.current?.focus?.();
    };
  }, [onClose]);

  return { ref, props: dialogProps(label) };
}
