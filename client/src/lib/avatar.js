// Mesh-orb avatars. Every identity in quorum is a keypair, so every avatar
// is derived, never uploaded: hash the handle into an anchor hue, derive two
// companion hues from it, and let the hash place soft color blobs that blur
// into one wash. Color is the identity — two handles read apart at a glance
// even at roster size, which pixel grids and glyphs never managed.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Small deterministic PRNG so blob geometry is stable per handle.
function prng(seed) {
  let a = seed || 1;
  return () => {
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
}

const hsl = (h, s, l) => `hsl(${Math.round((h + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

/** Deterministic orb geometry + palette for a handle. Coordinates live in a
    40×40 viewBox; the Seal component scales them to any size. */
export function orbParams(name) {
  const seed = fnv1a(String(name ?? '?'));
  const r = prng(seed);
  const hue = seed % 360;
  const flip = r() < 0.5 ? -1 : 1;
  const base = hsl(hue, 72, 58);
  const companion = hsl(hue + flip * (24 + r() * 22), 80, 66);
  const contrast = hsl(hue + flip * (110 + r() * 70), 68, 62);
  const highlight = hsl(hue - flip * (18 + r() * 14), 62, 80);
  const blob = (color, radius) => {
    const a = r() * Math.PI * 2;
    const d = 4 + r() * 11;
    return {
      x: +(20 + Math.cos(a) * d).toFixed(1),
      y: +(20 + Math.sin(a) * d).toFixed(1),
      r: +radius.toFixed(1),
      color,
    };
  };
  return {
    hue,
    base,
    blobs: [
      blob(companion, 13 + r() * 5),
      blob(contrast, 11 + r() * 5),
      blob(highlight, 7 + r() * 4),
    ],
  };
}

/** Anchor hue only — for surfaces that want to color something (a cover, a
    ring) in a member's or game's identity hue without drawing the orb. */
export function nameHue(name) {
  return fnv1a(String(name ?? '?')) % 360;
}
