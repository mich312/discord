// PROTOTYPE — a circle's derived mark.
//
// Members and circles are both identified by a hue, but they are different
// kinds of thing and should read differently: a member is a person, so their
// mark is an organic wash (avatar.js); a circle is an institution, so its
// mark is geometric — closer to a flag than a face.
//
// v2. The first attempt was a 4×4 mirrored grid, and at 44px it read as
// compression artefacts: too many cells, too little contrast between them,
// and two circles of similar hue were indistinguishable. This version borrows
// from heraldry instead, which solved the same problem — be legible on a
// moving object at distance — with very few, very large shapes. One division
// of the field, two tones, sometimes one charge on top.
//
// Hues are quantised to a 12-stop wheel rather than taken raw from the hash.
// Eight raw hashes cluster by chance; twelve fixed stops guarantee that
// neighbours in the rail are far apart, and the set reads as chosen rather
// than random.

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

const STOPS = 12;

/** A circle's anchor hue, quantised to the wheel. Stable across renames. */
export function idHue(id) {
  return (fnv1a(id) % STOPS) * (360 / STOPS);
}

// One division of the field, in a 40×40 viewBox. Each is a path drawn *over*
// the base fill in the second tone. `null` leaves the field plain, which is
// the quietest and most confident of the set — some circles should just be a
// colour.
const DIVISIONS = [
  null,
  'M0 0 H20 V40 H0 Z', // per pale — left half
  'M0 0 H40 V20 H0 Z', // per fess — top half
  'M0 0 H40 L0 40 Z', // per bend — diagonal
  'M14 0 H26 V40 H14 Z', // pale — centre stripe
  'M0 14 H40 V26 H0 Z', // fess — centre band
  'M0 0 H20 V20 H0 Z M20 20 H40 V40 H20 Z', // quarterly
  'M0 26 H40 V40 H0 Z', // base — foot band
];

export function crestParams(id) {
  const seed = fnv1a(id);
  const r = prng(seed);
  const hue = idHue(id);
  const division = DIVISIONS[Math.floor(r() * DIVISIONS.length)];
  // A charge only when the field is plain or simply divided — two shapes and
  // a charge is where it starts looking busy again.
  const charge = r() < 0.38 ? (r() < 0.5 ? 'roundel' : 'bar') : null;

  return {
    hue,
    // The base gradient stays close in hue so the *division* carries the
    // difference, not the background.
    from: `hsl(${hue} 58% 38%)`,
    to: `hsl(${(hue + 20) % 360} 64% 52%)`,
    division,
    charge,
  };
}
