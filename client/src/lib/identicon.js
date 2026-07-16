// Deterministic "seal" identicons. Every identity in quorum is a keypair,
// so every avatar is derived, never uploaded: hash the handle, use the bits
// to pick two hues, a rotation and a pattern of arc segments. The same
// handle renders the same seal on every device — a visual fingerprint,
// cheaper than a safety number but pointing at the same idea.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The stable hue (0–359) that IS this user's color everywhere: seal,
    name, waveform, speaking glow. Derived from the handle, so every
    device computes the same color without any coordination. */
export function userHue(name) {
  return fnv1a(String(name ?? '?')) % 360;
}

/** Inline style carrying the user's hue as a CSS variable. Components put
    this on any element whose subtree renders identity-colored ink; the
    stylesheet turns `--uh` into a readable color per theme. */
export function userTint(name) {
  return { '--uh': userHue(name) };
}

export function sealParams(name) {
  const h = fnv1a(String(name ?? '?'));
  const hue = h % 360;
  const hue2 = (hue + 36 + ((h >>> 9) % 84)) % 360;
  const rotate = (h >>> 3) % 360;
  // 10 outer-ring segments; roughly half lit, never none.
  const bits = [];
  for (let i = 0; i < 10; i++) bits.push(((h >>> (i + 4)) & 1) === 1);
  if (!bits.some(Boolean)) bits[h % 10] = true;
  return { hue, hue2, rotate, bits };
}

export function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0));
  const y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
