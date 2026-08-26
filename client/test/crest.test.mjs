// The circle mark's contrast contract.
//
// A circle's tile is generated from its id, so it is the one surface in the
// product whose colour no designer ever looks at. Every other colour decision
// went through a person; this one goes through a hash. That makes it exactly
// the kind of thing that ships a yellow tile with a white glyph on it and
// nobody notices for a year.
//
// styles.css says "5.00:1 against every tile the wheel can produce". §3.2:
// a comment that claims a ratio is a test assertion. This is the assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { idHue, circleFill, hslLuminance, TILE_LUMINANCE } from '../src/lib/crest.js';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

function channels(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a, b) => {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

const parse = (fill) => {
  const m = fill.match(/^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/);
  assert.ok(m, `circleFill must return a plain hsl() triple, got: ${fill}`);
  return [+m[1], +m[2], +m[3]];
};

/** Every hue the wheel can land on, not a sample of ids — the mark has to
    hold for the tenth circle somebody creates, not the ones we thought of. */
const EVERY_HUE = (() => {
  const seen = new Map();
  for (let i = 0; seen.size < 10 && i < 5000; i++) {
    const id = `srv-${i}`;
    if (!seen.has(idHue(id))) seen.set(idHue(id), id);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
})();

test('the wheel is fully covered by the ids this walks', () => {
  assert.equal(EVERY_HUE.length, 10, 'idHue quantises to 10 stops — all of them must be reached');
});

test('a circle mark never lands in the coral dead zone', () => {
  // The accent means "selected". A circle whose face sits at ~349° looks
  // permanently chosen, in a list where exactly one circle is.
  for (const [hue, id] of EVERY_HUE) {
    assert.ok(hue >= 15 && hue <= 295, `${id} is at ${hue}°, inside the coral exclusion`);
  }
});

test('every tile sits on the same relative luminance', () => {
  for (const [, id] of EVERY_HUE) {
    const Y = hslLuminance(...parse(circleFill(id)));
    assert.ok(
      Math.abs(Y - TILE_LUMINANCE) < 0.001,
      `${id} solved to Y=${Y.toFixed(4)}, not ${TILE_LUMINANCE}`,
    );
  }
});

test('the glyph clears 4.5:1 on every tile, and styles.css quotes the number', () => {
  const white = luminance(channels('#ffffff'));
  for (const [, id] of EVERY_HUE) {
    const r = ratio(white, hslLuminance(...parse(circleFill(id))));
    assert.ok(r >= 4.5, `${id}: glyph at ${r.toFixed(2)}:1`);
    assert.equal(r.toFixed(2), '5.00', `${id}: the tiles must all be one ratio`);
  }
  assert.match(
    css,
    /5\.00:1\s+against\s+every\s+tile/,
    'the mark rule must quote the ratio this test holds',
  );
});

test('the tile itself clears 3:1 against the panel it sits on, in both themes', () => {
  // Non-text, so 3:1 (§3.1). This is what stops a dark tile vanishing into
  // carbon and a light one vanishing into paper — one luminance cannot suit
  // both unless it is picked to, so check that it was.
  const panels = { carbon: '#101012', paper: '#f2f0eb' };
  for (const [theme, hex] of Object.entries(panels)) {
    assert.match(css, new RegExp(hex, 'i'), `${hex} must still be a --panel value`);
    for (const [, id] of EVERY_HUE) {
      const r = ratio(hslLuminance(...parse(circleFill(id))), luminance(channels(hex)));
      assert.ok(r >= 3, `${id} on ${theme}: ${r.toFixed(2)}:1`);
    }
  }
});

test('the mark is keyed to the id, so a rename does not change a circle face', () => {
  // The rail derived its hue from the name, which meant renaming a circle
  // silently gave it someone else's face. The mark is identity; identity does
  // not move because the label did.
  assert.equal(circleFill('srv-race'), circleFill('srv-race'));
  assert.notEqual(circleFill('srv-race'), circleFill('srv-race-2'));
});
