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
