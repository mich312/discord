// The "when to ask" decision for the first-run notifications prompt. Pure, so
// it's tested without a DOM — the component just renders on its verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptNotifications } from '../src/lib/notify-prompt.js';

test('prompts when supported, undecided, and not yet asked', () => {
  assert.equal(
    shouldPromptNotifications({ supported: true, permission: 'default', asked: false }),
    true
  );
});

test('never prompts when the browser has no Notification API', () => {
  assert.equal(
    shouldPromptNotifications({ supported: false, permission: 'unsupported', asked: false }),
    false
  );
});

test('does not prompt once already granted — nothing left to ask', () => {
  assert.equal(
    shouldPromptNotifications({ supported: true, permission: 'granted', asked: false }),
    false
  );
});

test('does not prompt when blocked — script cannot undo a denial', () => {
  assert.equal(
    shouldPromptNotifications({ supported: true, permission: 'denied', asked: false }),
    false
  );
});

test('does not re-ask a device that already answered the prompt', () => {
  assert.equal(
    shouldPromptNotifications({ supported: true, permission: 'default', asked: true }),
    false
  );
});
