import React from 'react';
import { circleFill, DEFAULT_GLYPH } from '../lib/crest.js';
import { Users, Gamepad, Camera, Archive } from './icons.jsx';

// A circle's mark: a flat tile in the circle's own colour carrying one glyph.
//
// The shape is the whole point. A member's mark is a round mesh orb
// (Seal.jsx); a circle's is a rounded square with a glyph on it. Round means
// person, tile means place, and that reads before the colour does — which is
// what stops a circle in a list of faces from looking like somebody nobody
// recognises.
//
// It is never blank and never a monogram. A monogram spells the name a second
// time next to the name, and it changes when the circle is renamed; the tile
// is keyed to the circle id and defaults to the `people` glyph, so a circle
// has a face from the moment it is created and keeps it through a rename.

// Four glyphs, and the reason there are only four: §11.4 — vocabulary that
// appears once is noise. These are the kinds of circle the product is
// actually for. A fifth belongs here when a fifth kind exists, not before.
// The keys live in lib/crest.js because they travel on the wire; only the
// paths are here.
export const CIRCLE_GLYPHS = {
  people: Users,
  games: Gamepad,
  photo: Camera,
  project: Archive,
};

// §6.1 — icons render at 14, 18 or 24 and nothing between. The tile sizes are
// picked to suit those three rather than the other way round: the glyph is the
// content, the tile is the frame.
function glyphSize(size) {
  if (size >= 40) return 24;
  if (size >= 26) return 18;
  return 14;
}

export default function CircleMark({ id, name, glyph, size = 28, className }) {
  const Glyph = CIRCLE_GLYPHS[glyph] ?? CIRCLE_GLYPHS[DEFAULT_GLYPH];
  // Where the mark sits next to the circle's name — or inside a control that
  // already names it — it is decoration, and a second announcement of the
  // same name is noise. `name` is what decides, so a caller cannot get an
  // empty `aria-label` onto a `role="img"` by accident.
  const labelled = Boolean(name);
  return (
    <span
      className={className ? `circle-mark ${className}` : 'circle-mark'}
      // Generated per circle, so it cannot be a token — the same exemption
      // the member orbs run under. styles.css consumes it; tokens.test.mjs
      // knows this component sets it.
      style={{ '--circle-fill': circleFill(id), width: size, height: size }}
      {...(labelled ? { role: 'img', 'aria-label': name } : { 'aria-hidden': 'true' })}
    >
      <Glyph size={glyphSize(size)} />
    </span>
  );
}
