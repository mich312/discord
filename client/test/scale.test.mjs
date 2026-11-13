// §2.6–2.9 — the scales, and what is still outside them.
//
// The guidelines' claim is that these scales already existed and nobody had
// written them down, so 5/7/9/11/13px filled in as noise. That is a claim
// about a number, so it goes here as a number: each check counts today's
// literals and treats the count as a ceiling. Existing debt is visible;
// new debt fails the build.
//
// The z-index scale is the one that is finished — seven tiers, seven
// tokens, nothing outside them — so it is asserted at zero rather than
// against a ceiling. That is what these ceilings are for: to be walked down
// to zero and then replaced by an assertion like that one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raw = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
// Comments explain the debt; they are not the debt.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration in the sheet, as [property, value]. */
const declarations = [...css.matchAll(/([-a-zA-Z]+)\s*:\s*([^;{}]+)[;}]/g)].map((m) => [
  m[1],
  m[2].trim(),
]);

/** Which line a declaration is on, for a failure message that can be acted on. */
function locate(prop, value) {
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => l.includes(`${prop}:`) && l.includes(value));
  return i < 0 ? '?' : i + 1;
}

function report(hits, ceiling, rule) {
  const listed = hits
    .slice(0, 8)
    .map(([p, v]) => `${p}: ${v} (line ${locate(p, v)})`)
    .join('\n  ');
  assert.ok(
    hits.length <= ceiling,
    `${rule}: ${hits.length} literals, ceiling ${ceiling}. Ceilings shrink, never grow.\n  ${listed}${
      hits.length > 8 ? `\n  …and ${hits.length - 8} more` : ''
    }`
  );
}

/* --------------------------------------------------------- 2.6 spacing -- */

// 499 literal px spacing declarations across 30-odd distinct values, of
// which the top six cover two thirds. Writing the scale down is a separate
// change from stopping the bleeding; this is the second one.
// Walked down from 499 when the scale (--s-1 … --s-8) was written into the
// token block and the cleanup pass rebuilt the board, roster and call stage
// on it.
const SPACING_CEILING = 449;
const SPACING = /^(padding|margin|gap|row-gap|column-gap|inset)(-(top|right|bottom|left|inline|block))?$/;

test('spacing literals do not grow past today’s count', () => {
  const hits = declarations.filter(([p, v]) => SPACING.test(p) && /\d+px/.test(v));
  report(hits, SPACING_CEILING, '§2.6 spacing');
});

/* ------------------------------------------------------- 2.7 type scale -- */

// 13px is the most-used size in the product and is not a token — which is
// most of this number. A `--text-*` step for it is the fix, and it is a
// rename across ~19 sites rather than a lint.
// Was 34. --text-ui (13px) is now a step, and the cleanup moved its sites.
const TYPE_CEILING = 10;

test('font-size literals do not grow past today’s count', () => {
  const hits = declarations.filter(
    ([p, v]) => p === 'font-size' && /\d/.test(v) && !v.includes('var(')
  );
  report(hits, TYPE_CEILING, '§2.7 font-size');
});

test('no font size is a decimal', () => {
  // Half a pixel is not a step on a scale, it is somebody nudging a value
  // until one screenshot looked right.
  const hits = declarations.filter(
    ([p, v]) =>
      (p === 'font-size' && /\d+\.\d+px/.test(v)) ||
      (p === 'font' && /\b\d+\.\d+px\b/.test(v))
  );
  assert.deepEqual(hits, [], '§2.7 — never a decimal size');
});

test('the font shorthand’s size slot does not grow past today’s count', () => {
  const hits = declarations.filter(([p, v]) => p === 'font' && /\b\d+(\.\d+)?px\b/.test(v));
  report(hits, 2, '§2.7 font shorthand');
});

test('nothing renders below the 10px floor', () => {
  // §4.3 is a floor, not a ceiling-with-debt: below 10px is not a smaller
  // step, it is unreadable. *9px badges were carrying trust state.*
  const tooSmall = declarations.filter(([p, v]) => {
    const m =
      p === 'font-size' ? v.match(/^(\d+(?:\.\d+)?)px/) : p === 'font' ? v.match(/\b(\d+(?:\.\d+)?)px\b/) : null;
    return m && Number(m[1]) < 10;
  });
  assert.deepEqual(tooSmall, [], '§4.3 — minimum type size is 10px');
});

/* ----------------------------------------------------------- 2.8 motion -- */

// Mostly keyframe durations, which are a different question from the
// transition tiers --fast/--slow: a shimmer is not a state change. The
// number is here so a sixth component choosing .12s is visible.
const MOTION_CEILING = 23;

test('duration literals do not grow past today’s count', () => {
  const hits = declarations.filter(
    ([p, v]) => /^(transition|animation)(-duration)?$/.test(p) && /\b\d+(\.\d+)?m?s\b/.test(v)
  );
  report(hits, MOTION_CEILING, '§2.8 duration');
});

/* ---------------------------------------------------------- 2.9 z-index -- */

test('every z-index comes from the scale', () => {
  // Finished, and asserted at zero. A stacking context that genuinely owns
  // its own order may use 0 or 1 with a comment saying so.
  const hits = declarations.filter(
    ([p, v]) => p === 'z-index' && !v.startsWith('var(--z-') && !/^(0|1|auto)$/.test(v)
  );
  assert.deepEqual(hits, [], '§2.9 — z-index takes a --z-* token');
});

test('the layering scale stays ordered', () => {
  // The tokens are only worth having if reading them in order tells you what
  // sits over what. A tier inserted out of order would silently put a
  // palette over a modal.
  const order = ['raised', 'pop', 'dock', 'palette', 'modal', 'toast', 'skip'];
  const values = order.map((name) => {
    const m = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`));
    assert.ok(m, `--z-${name} is missing`);
    return Number(m[1]);
  });
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `--z-${order[i]} must sit above --z-${order[i - 1]}`);
  }
});

/* ----------------------------------------------------- 4.4 the capitals -- */

test('nothing is set in transformed capitals', () => {
  // §4.4 kept all-caps mono for machine data, and the product spent it on
  // every label, tab, badge, warning and button instead — 41 uppercase
  // transforms, which is most of why it read as decoration. Sentence case is
  // typed, not transformed, so this is asserted at zero rather than against
  // a ceiling: a code or an id that genuinely is capitals is written that way.
  const hits = declarations.filter(([p, v]) => p === 'text-transform' && v === 'uppercase');
  assert.deepEqual(hits, [], '§4.4 — write sentence case; do not transform it');
});

/* ------------------------------------------------- 1.2 green is not a socket -- */

test('the connection dot never borrows green', () => {
  // §1.2 names this case: a websocket rendered in the green of a verified
  // key teaches "green = safe" and then spends it on a socket. The dot was
  // var(--ok) online and var(--accent) while connecting.
  const rules = [...css.matchAll(/([^{}]*\.conn-dot[^{}]*)\{([^}]*)\}/g)];
  const bad = rules.filter(([, , body]) => /var\(--(ok|accent)\b/.test(body)).map(([, sel]) => sel.trim());
  assert.deepEqual(bad, [], '§1.1, §1.2 — connection state is neutral, or red when broken');
});

/* ----------------------------------------------------------- 6.1 icons -- */

test('icons render at 14, 18 or 24 only', () => {
  // §6.1. Its cautionary example said "seventeen icon sizes were in use", and
  // at the time of the cleanup there were still seventeen, with 106 of 175
  // icon call sites off the scale. Avatars (Seal), circle marks and the
  // brand glyph are sized freely — they are identity, not icons.
  const dir = fileURLToPath(new URL('../src/components/', import.meta.url));
  const iconSrc = readFileSync(`${dir}icons.jsx`, 'utf8');
  const icons = [...iconSrc.matchAll(/^export const (\w+)/gm)]
    .map((m) => m[1])
    .filter((n) => n !== 'QuorumGlyph');
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith('.jsx')).map((f) => `${dir}${f}`),
    fileURLToPath(new URL('../src/App.jsx', import.meta.url)),
  ];
  const off = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(new RegExp(`<(${icons.join('|')})\\b[^>]*?\\bsize=\\{(\\d+)\\}`, 'g'))) {
      if (![14, 18, 24].includes(Number(m[2]))) {
        const line = src.slice(0, m.index).split('\n').length;
        off.push(`${f.split('/src/')[1]}:${line} <${m[1]} size={${m[2]}}>`);
      }
    }
  }
  assert.deepEqual(off, [], `§6.1 — 14, 18 or 24:\n${off.join('\n')}`);
});
