// memberVtName must produce a valid, stable CSS custom-ident for each roster
// handle — that's what lets the browser match a member's row before and after
// a regroup and slide it (FLIP) instead of cross-dissolving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberVtName } from '../src/lib/viewTransition.js';

test('memberVtName is a valid custom-ident (never starts with a digit)', () => {
  for (const h of ['alice', '9lives', '_x', 'a.b.c', 'zoë']) {
    const name = memberVtName(h);
    assert.match(name, /^vt-m-[a-zA-Z0-9-]*$/, `${name} is a valid ident body`);
    assert.match(name[0], /[a-zA-Z]/, 'starts with a letter, so it is a legal ident');
  }
});

test('memberVtName is stable for the same handle', () => {
  assert.equal(memberVtName('bob'), memberVtName('bob'));
});

test('distinct simple handles map to distinct names', () => {
  const names = ['alice', 'bob', 'carol', 'dana'].map(memberVtName);
  assert.equal(new Set(names).size, names.length, 'no collisions among plain handles');
});

test('handles that differ only in punctuation get distinct transition names', () => {
  // A duplicate view-transition-name aborts the entire transition, not just
  // the offending element, so "a.b.c" and "a-b-c" collapsing to one name
  // silently killed the roster animation whenever both were present.
  assert.notEqual(memberVtName('a.b.c'), memberVtName('a-b-c'));
  assert.notEqual(memberVtName('bob_1'), memberVtName('bob.1'));
  assert.equal(memberVtName('alice'), memberVtName('alice'), 'still stable per handle');
  assert.ok(/^vt-m-[a-zA-Z0-9-]+$/.test(memberVtName('a.b.c')), 'still a valid ident');
});
