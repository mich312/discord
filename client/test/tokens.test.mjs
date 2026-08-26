// The token contract.
//
// Two tokens shipped for months without ever being defined: `--warn` and
// `--r-md`. Both call sites carried an inline fallback, so nothing broke
// loudly — the fallback simply always won, which meant an amber that never
// changed with the theme (2.49:1 on paper) and a radius off the scale. A
// fallback is exactly what stops that being visible, which is why one on a
// token that exists is banned outright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
// Comments are heavily used in this file and mention token names in prose.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

const defined = new Set([...bare.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
const used = new Set([...bare.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]));

// Custom properties set from JSX rather than declared in the stylesheet.
// An entry here must name the component that sets it.
const SET_IN_JS = new Set([
  // CircleMark.jsx — a circle's tile colour is generated from its id, so it
  // cannot be a token. crest.test.mjs holds its contrast instead.
  'circle-fill',
]);

test('every var(--x) resolves to a definition', () => {
  const missing = [...used].filter((t) => !defined.has(t) && !SET_IN_JS.has(t)).sort();
  assert.deepEqual(missing, [], `undefined tokens: ${missing.join(', ')}`);
});

test('no token is defined and never used', () => {
  const dead = [...defined].filter((t) => !used.has(t)).sort();
  assert.deepEqual(dead, [], `dead tokens: ${dead.join(', ')}`);
});

test('no var() carries a fallback for a token that exists', () => {
  const withFallback = [...bare.matchAll(/var\(\s*--([a-z0-9-]+)\s*,([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((t) => defined.has(t));
  assert.deepEqual(
    [...new Set(withFallback)].sort(),
    [],
    'a fallback on a defined token silently survives a rename — drop it',
  );
});

test('colour tokens are themed and non-colour tokens are not', () => {
  const paletteOf = (re, what) => {
    const m = bare.match(re);
    assert.ok(m, `${what} must exist`);
    return new Map(
      [...m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]),
    );
  };
  const root = paletteOf(/:root \{([\s\S]*?)\n\}/, 'the :root block');
  const paper = paletteOf(/\[data-theme='paper'\] \{([\s\S]*?)\n\}/, 'the paper block');

  // A value is a colour if it names one. `--scrollbar` and `--backdrop` are
  // rgba, `--overlay-shadow` embeds one; all three are legitimately themed.
  const isColour = (v) => /#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|color-mix\(/.test(v);

  const unthemed = [...root].filter(([k, v]) => isColour(v) && !paper.has(k)).map(([k]) => k);
  assert.deepEqual(unthemed, [], `colour tokens with no paper override: ${unthemed.join(', ')}`);

  const overThemed = [...paper].filter(([k]) => root.has(k) && !isColour(root.get(k))).map(([k]) => k);
  assert.deepEqual(overThemed, [], `non-colour tokens overridden per theme: ${overThemed.join(', ')}`);
});
