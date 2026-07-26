// Overlays had no dialog semantics and no focus management: a screen reader
// announced nothing, Tab walked out of the dialog into the app behind it,
// and closing dropped focus. With a modal open the app was not keyboard-
// usable at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogProps } from '../src/lib/useDialog.js';

// The focus trap itself needs a live DOM, so what is asserted here is the
// ARIA contract every overlay spreads onto its dialog element — the part
// that was missing entirely.
test('the hook advertises the dialog to assistive technology', () => {
  const props = dialogProps('Settings');
  assert.equal(props.role, 'dialog');
  assert.equal(props['aria-modal'], 'true');
  assert.equal(props['aria-label'], 'Settings');
});

test('the dialog element is focusable so focus is never left outside it', () => {
  const props = dialogProps('Settings');
  assert.equal(props.tabIndex, -1, 'programmatically focusable, not in the tab order');
});

test('a dialog without a label omits aria-label rather than emitting an empty one', () => {
  const props = dialogProps(undefined);
  assert.ok(!('aria-label' in props), 'no empty label to mis-announce');
});
