// PROTOTYPE — a circle's derived mark.
//
// Members and circles are both identified by a hue, and both marks are
// generated gradients — but they are different kinds of thing and should read
// differently. A member is a person, so their orb is organic: soft blobs
// blurred into one wash (avatar.js). A circle is a place, so its mark is
// deeper and more architectural — a wash with direction and a light source.
//
// Two earlier attempts are worth recording, because both failed for the same
// reason and it is the governing constraint here:
//
//   v1  a 4×4 mirrored grid. At 44px it read as compression artefacts.
//   v2  heraldic divisions — flat white shapes over a gradient. Legible, but
//       the flat overlay fought the gradient underneath instead of belonging
//       to it, and the marks read as UI rather than as identity.
//
// The constraint: at 44px, only large soft fields survive. So the variation
// has to live in the gradient itself — its hues, its geometry, and where its
// light falls — not in shapes drawn on top of it.
//
// Three axes of variation, which is what keeps a rail of eight legible:
//   · anchor hue, quantised to a wheel so neighbours never sit close
//   · spread — how far the companion hues travel from the anchor
//   · geometry — a linear sweep at one of several angles, or a radial with
//     an off-centre focal point
//
// Keyed to the circle *id*, never the name. Rail.jsx derives its hue from the
// name today, so renaming a circle silently changes its face.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function prng(seed) {
  let a = seed || 1;
  return () => {
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
}

// The accent lives at ~349°, and the accent means "selected" — a circle whose
// mark lands there looks permanently chosen. So the wheel is not a full
// circle: it is the arc from 15° to 295°, which leaves an 80° dead zone
// around coral that no circle can enter.
//
// Excluding the anchors is not enough on its own. A companion hue is
// anchor ± spread, and with a wide spread a violet anchor wraps straight back
// into coral — which is exactly what the first pass at this did. Every hue,
// anchor and companion alike, is clamped into the arc.
const SAFE_LO = 15;
const SAFE_HI = 295;
const STOPS = 10;

const clampHue = (h) => Math.min(SAFE_HI, Math.max(SAFE_LO, h));
const hsl = (h, s, l) => `hsl(${Math.round(clampHue(h))} ${Math.round(s)}% ${Math.round(l)}%)`;

/** A circle's anchor hue, quantised to the safe arc. Stable across renames. */
export function idHue(id) {
  const step = (SAFE_HI - SAFE_LO) / (STOPS - 1);
  return Math.round(SAFE_LO + (fnv1a(id) % STOPS) * step);
}

/**
 * Deterministic gradient for a circle id, in a 40×40 viewBox.
 * Everything the mark is made of is a gradient; nothing is drawn on top.
 */
export function crestParams(id) {
  const seed = fnv1a(id);
  const r = prng(seed);
  const hue = idHue(id);

  // How far the companion hues travel. A narrow spread gives a deep, quiet,
  // near-monochrome tile; a wide one gives a two-tone sweep. Having both in
  // the same rail is most of what makes eight circles tell apart.
  const spread = 26 + r() * 66;
  const dir = r() < 0.5 ? -1 : 1;

  // Saturation stays under the neon line. The chrome around these is
  // deliberately quiet, and a rail of eight fully-saturated tiles turns into
  // the stock-gradient look the register exists to avoid.
  const deep = hsl(hue, 52 + r() * 8, 30 + r() * 7);
  const mid = hsl(hue + dir * spread, 58 + r() * 9, 45 + r() * 7);
  const lift = hsl(hue - dir * spread * 0.45, 50 + r() * 9, 58 + r() * 8);

  // Geometry is the second signal. A linear sweep reads as a plane; a radial
  // reads as a source — at rail size that difference is obvious even when two
  // circles share a hue family.
  const radial = r() < 0.45;
  const angle = [135, 155, 115, 90, 170][Math.floor(r() * 5)];

  return {
    hue,
    radial,
    angle,
    // Focal point for the radial form, kept off-centre and inside the tile.
    fx: +(0.28 + r() * 0.3).toFixed(3),
    fy: +(0.24 + r() * 0.3).toFixed(3),
    stops: [
      { offset: 0, color: lift },
      { offset: 0.52 + r() * 0.1, color: mid },
      { offset: 1, color: deep },
    ],
    // A second, softer gradient laid over the first — the light source. This
    // is what stops a two-stop ramp looking like a CSS default.
    sheenX: +(0.2 + r() * 0.4).toFixed(3),
    sheenY: +(0.14 + r() * 0.3).toFixed(3),
    sheen: 0.16 + r() * 0.16,
  };
}

/* ------------------------------------------------ the production mark -- */

// What shipped, after the treatments above: a flat tile in the circle's
// colour carrying one glyph. Everything from `crestParams` down is the
// gradient treatment the prototype boards compared and the design did not
// take — kept because it records why, not because anything renders it.
//
// Flat won for a reason the gradient could not answer: a glyph has to sit on
// top of the mark, and a glyph on a gradient has a different contrast ratio
// in every corner of the tile. Flat makes that one number, and one number is
// something a test can hold.

// Every tile is generated, so its contrast against the glyph is generated
// too — and a hue wheel does not hold lightness still. `hsl(60 55% 42%)` is
// yellow at Y≈0.44; `hsl(255 55% 42%)` is indigo at Y≈0.08. Pinning the
// *lightness* would ship one circle whose glyph is illegible and another
// whose tile disappears into the panel.
//
// So the fixed point is relative luminance, not lightness: solve for the L
// that puts every hue at the same Y. White-on-tile is then the same ratio
// for every circle in the product, and the tile clears 3:1 against the panel
// in both themes. `crest.test.mjs` asserts both, over every hue the wheel
// can produce.
//
// 0.16 is chosen for what it buys at both ends: white-on-tile lands at
// 5.00:1 (past AA for text, so the glyph is safe at any weight), and the
// tile clears --panel at 3.75:1 on carbon and 4.43:1 on paper.
const TILE_LUMINANCE = 0.16;
const TILE_SATURATION = 55;

/** sRGB relative luminance of an hsl() triple, per WCAG 2.x. */
function hslLuminance(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] = (
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x]
  ).map((v) => {
    const u = v + m;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The circle's tile colour: its anchor hue, at whatever lightness puts it on
 * the shared luminance. Bisection rather than a formula because luminance is
 * not invertible in closed form through the sRGB transfer curve — 24 steps
 * lands well inside a single 8-bit level.
 */
export function circleFill(id) {
  const h = idHue(id);
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (hslLuminance(h, TILE_SATURATION, mid) < TILE_LUMINANCE) lo = mid;
    else hi = mid;
  }
  return `hsl(${h} ${TILE_SATURATION}% ${((lo + hi) / 2).toFixed(2)}%)`;
}

/** The luminance every tile is solved onto — for the tests, and for anything
    that needs to know what a glyph is sitting on without re-deriving it. */
export { TILE_LUMINANCE, hslLuminance };

/** The glyphs a circle can wear. Keys, not components — this is lib, and the
    value travels inside an MLS envelope to every member's device, so it has
    to be a short string from a closed set rather than anything renderable.
    CircleMark.jsx owns the mapping to actual paths. */
export const CIRCLE_GLYPH_KEYS = ['people', 'games', 'photo', 'project'];

/** `people` — so a circle has a face the moment it is created and nobody has
    to configure anything for a list of circles to be legible. */
export const DEFAULT_GLYPH = 'people';

/** Whitelist a glyph off the wire. Anything unrecognised becomes the default
    rather than nothing: a circle whose admin is running a newer build should
    still have a face here, not a hole. */
export function normalizeGlyph(v) {
  return CIRCLE_GLYPH_KEYS.includes(v) ? v : DEFAULT_GLYPH;
}
