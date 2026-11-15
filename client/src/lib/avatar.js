// Member avatars: the first letter of the handle on a solid circle. Every
// identity is a keypair, so the mark is derived, never uploaded; the colour
// comes from circleFill() in crest.js (white text clears 4.5:1 on all of
// them), and the letter tells apart two people who drew the same colour.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Anchor hue for a name, for surfaces that colour something (a game cover)
    in its identity hue. */
export function nameHue(name) {
  return fnv1a(String(name ?? '?')) % 360;
}

let segmenter;

/** The first character a person would see in a handle, uppercased: a whole
    grapheme, so an accented letter or an emoji survives intact. */
export function initialOf(name) {
  const s = String(name ?? '').trim();
  if (!s) return '?';
  let first;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    first = segmenter.segment(s)[Symbol.iterator]().next().value.segment;
  } else {
    first = Array.from(s)[0];
  }
  return first.toLocaleUpperCase();
}
