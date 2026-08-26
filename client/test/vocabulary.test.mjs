// §5.7 — the class vocabulary, held to its own rules.
//
// Two failures this catches, both of which had already happened by the time
// it was written:
//
//   * A class with no rule. `.waiting` looked like a state modifier on a
//     ledger row and was in fact a global text-centring utility that lived
//     somewhere else entirely — so the row silently centred itself. A class
//     that names nothing is a name waiting to collide with something.
//   * A ternary that repeats the base: `on ? 'room-chip active' : 'room-chip'`.
//     There were 52. It reads as two class names rather than one class and
//     one state, so a rename has to find both halves, and composing a second
//     state turns it into a four-way ternary. `cx()` is the fix.
//
// Both are seeded with today's count as a ceiling (§12: allowlists shrink,
// never grow). The orphan list is named rather than counted, because a
// number tells you the debt exists and a list tells you what it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));

function jsxFiles(dir = root, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) jsxFiles(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const css =
  readFileSync(join(root, 'styles.css'), 'utf8') +
  readFileSync(join(root, 'prototypes.css'), 'utf8');

/** Every class name the stylesheets define a rule for. */
const defined = new Set(
  [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])
);

/** Every class name the components ask for, from a literal `className` and
    from a `cx()` argument list. Interpolated names are skipped: a template
    hole is not a name this file can check. */
function classesUsed() {
  const used = new Map();
  const add = (name, file) => {
    if (!name || name.includes('$') || name.includes('{')) return;
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(file.slice(root.length + 1));
  };
  for (const f of jsxFiles()) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/className=(?:\{)?[`'"]([^`'"]*)[`'"]/g)) {
      // An interpolated template carries no checkable name — `${x ? 'a' :
      // 'b'}` would otherwise contribute a class called "?".
      if (m[1].includes('${')) continue;
      for (const c of m[1].split(/\s+/)) add(c, f);
    }
    for (const m of s.matchAll(/\bcx\(([^)]*)\)/g)) {
      for (const q of m[1].matchAll(/'([^']+)'/g)) {
        for (const c of q[1].split(/\s+/)) add(c, f);
      }
    }
  }
  return used;
}

/* ------------------------------------------------- classes with no rule -- */

// Today's debt, named. Each of these is a class the JSX asks for that no
// stylesheet defines — most are test or query hooks that should be
// `data-testid`, a few are leftovers from a component that changed shape.
// This list is a ceiling: shrink it, never add to it.
const ORPHANS = new Set([
  'chat',
  'circle-card-next',
  'create',
  'crew',
  'incoming',
  'load-older',
  'member-remove',
  'msg',
  'muted-badge',
  'now',
  'outgoing',
  'overview-pane',
  'ringing',
  'signin',
  'vp-name',
]);

test('every class a component asks for has a rule behind it', () => {
  const used = classesUsed();
  const orphans = [...used.keys()].filter((c) => !defined.has(c) && !ORPHANS.has(c)).sort();
  assert.deepEqual(
    orphans,
    [],
    `classes with no CSS rule (§5.7 — use data-testid for hooks): ${orphans
      .map((c) => `${c} [${[...used.get(c)].join(', ')}]`)
      .join('; ')}`
  );
});

test('the orphan list only shrinks', () => {
  // A name that has since grown a rule should come off the list, not sit on
  // it forever pretending to be debt.
  const stale = [...ORPHANS].filter((c) => defined.has(c));
  assert.deepEqual(stale, [], `these now have rules and should leave the list: ${stale}`);
  const used = classesUsed();
  const gone = [...ORPHANS].filter((c) => !used.has(c));
  assert.deepEqual(gone, [], `these are no longer used and should leave the list: ${gone}`);
});

/* ------------------------------------------ the base-duplicating ternary -- */

test('no class string is built by a ternary that repeats its base', () => {
  const offenders = [];
  for (const f of jsxFiles()) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/className=\{([^{}?]+?)\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\}/g)) {
      const a = m[2].split(/\s+/);
      const b = m[3].split(/\s+/);
      const shares =
        (a.length > b.length && a.slice(0, b.length).join(' ') === b.join(' ')) ||
        (b.length > a.length && b.slice(0, a.length).join(' ') === a.join(' '));
      if (shares) {
        const line = s.slice(0, m.index).split('\n').length;
        offenders.push(`${f.slice(root.length + 1)}:${line} — ${m[0].slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `use cx(base, cond && 'state') instead:\n${offenders.join('\n')}`);
});

/* -------------------------------------------------- the inline-style budget -- */

// Inline style is how a value that belongs in the stylesheet gets in without
// passing any of these checks. A handful are legitimate — a computed hue, a
// measured height — and the budget exists so the handful stays one.
const INLINE_BUDGET = 7;

test('inline styles stay within budget', () => {
  const found = jsxFiles().flatMap((f) => {
    const s = readFileSync(f, 'utf8');
    return [...s.matchAll(/style=\{\{/g)].map((m) => {
      const line = s.slice(0, m.index).split('\n').length;
      return `${f.slice(root.length + 1)}:${line}`;
    });
  });
  assert.ok(
    found.length <= INLINE_BUDGET,
    `${found.length} inline styles, budget ${INLINE_BUDGET}:\n${found.join('\n')}`
  );
});
