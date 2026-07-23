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
