// The contrast contract.
//
// This exists because a hand-written claim aged into a false one: styles.css
// carried a comment announcing that a token tier had been "raised to clear
// 4.5:1", quoting 3.71:1 and 2.85:1 as the values it had corrected. Those were
// the live numbers of --ink-mute, one token over, which carried ~90 colour
// declarations of 10-12px metadata and failed AA on every surface in both
// themes. The comment was true of --ink-dim and nothing else.
//
// So: a comment that claims a ratio is an assertion, and this is where it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/* ------------------------------------------------------------- WCAG 2.x -- */

function channels(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG relative luminance. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(channels(fg));
  const b = luminance(channels(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Pin the implementation to the reference values before trusting it against
// the palette. A contrast test with a subtly wrong curve is worse than none:
// it would certify the failures it exists to catch.
test('the luminance implementation matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
  assert.equal(contrast('#949494', '#ffffff').toFixed(2), '3.03');
});

/* --------------------------------------------------------- the palettes -- */

/** Pull `--token: #value;` pairs out of one declaration block. */
function palette(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function block(re, what) {
  const m = css.match(re);
  assert.ok(m, `${what} must exist in styles.css`);
  return palette(m[1]);
}

const carbon = block(/:root \{([\s\S]*?)\n\}/, 'the :root palette');
const paper = block(/\[data-theme='paper'\] \{([\s\S]*?)\n\}/, "the [data-theme='paper'] palette");

// Anything a user reads, against every surface it can be read on. --ink-mute
// is in this list deliberately: "muted" is a visual intent, not a licence to
// drop below the floor, and it carries more of the product's metadata than
// any other token.
const SURFACES = ['well', 'panel', 'raised', 'hover', 'active'];
const TEXT = ['ink', 'ink-dim', 'ink-mute', 'accent-ink', 'ok', 'danger', 'warn'];

// Documented, deliberate exceptions. Empty, and it should stay that way:
// an entry here is a decision to ship text somebody cannot read. Each one
// needs the measured ratio and a reason, so it can be argued with later.
const EXEMPT = {
  // 'paper:danger:active': { ratio: 3.98, why: '…' },
};

for (const [theme, tokens] of [
  ['carbon', carbon],
  ['paper', paper],
]) {
  test(`${theme}: every text token clears 4.5:1 on every surface`, () => {
    const failures = [];
    for (const t of TEXT) {
      assert.ok(tokens[t], `${theme} is missing --${t}`);
      for (const s of SURFACES) {
        assert.ok(tokens[s], `${theme} is missing --${s}`);
        if (EXEMPT[`${theme}:${t}:${s}`]) continue;
        const r = contrast(tokens[t], tokens[s]);
        if (r < 4.5) failures.push(`--${t} (${tokens[t]}) on --${s} (${tokens[s]}) = ${r.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
  });

  // The label sits on the fill, so this pair is invisible to the loop above —
  // and it is every "join", "enter", "copy link" and "mark verified" in the
  // product. Paper shipped it at 3.75.
  test(`${theme}: primary button labels clear 4.5:1 on the accent fill`, () => {
    const r = contrast(tokens['on-accent'], tokens.accent);
    assert.ok(r >= 4.5, `--on-accent on --accent = ${r.toFixed(2)}, need 4.5`);
  });

  // 1.4.11: a focus ring is a UI component, not text, so 3:1 — but it has to
  // hold against the *selected* row's background, which is the lightest one.
  test(`${theme}: the focus ring clears 3:1 on every surface`, () => {
    const failures = [];
    for (const s of SURFACES) {
      const r = contrast(tokens.accent, tokens[s]);
      if (r < 3) failures.push(`--accent on --${s} = ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
  });
}

test('the two themes define the same colour tokens', () => {
  assert.deepEqual(Object.keys(carbon).sort(), Object.keys(paper).sort());
});
