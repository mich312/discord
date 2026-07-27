// PROTOTYPE — a circle's tile mark.
//
// Everything the mark is made of is a gradient: a generated ramp, plus a
// softer overlaid one standing in for a light source. Nothing is drawn on
// top, which is what keeps it reading as identity rather than as UI.
//
// Three states, in order of preference: a chosen crest glyph over the
// generated gradient; the gradient alone; and the monogram we ship today. The
// fallback chain matters — a circle has a face the moment it is created, so
// nobody has to configure anything for the rail to be legible.
import React, { useId } from 'react';
import { crestParams } from '../lib/crest.js';

export default function Crest({ id, name, size = 44, glyph: Glyph = null }) {
  const uid = useId();
  const { radial, angle, fx, fy, stops, sheenX, sheenY, sheen } = crestParams(id);

  // An angle in a 0→1 gradient space, so the sweep crosses the whole tile
  // whichever direction it runs.
  const rad = (angle * Math.PI) / 180;
  const x1 = 0.5 - Math.cos(rad) * 0.5;
  const y1 = 0.5 - Math.sin(rad) * 0.5;
  const x2 = 0.5 + Math.cos(rad) * 0.5;
  const y2 = 0.5 + Math.sin(rad) * 0.5;

  return (
    <svg
      className="crest"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={name}
    >
      <defs>
        {radial ? (
          <radialGradient id={`${uid}g`} cx={fx} cy={fy} r="1.05">
            {stops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </radialGradient>
        ) : (
          <linearGradient id={`${uid}g`} x1={x1} y1={y1} x2={x2} y2={y2}>
            {stops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        )}
        {/* the light source: a soft white fall-off, placed off-centre */}
        <radialGradient id={`${uid}s`} cx={sheenX} cy={sheenY} r="0.85">
          <stop offset="0" stopColor="#fff" stopOpacity={sheen} />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        {/* and a matching pool of shadow opposite it, so the tile has weight */}
        <radialGradient id={`${uid}d`} cx={1 - sheenX} cy={1 - sheenY} r="0.9">
          <stop offset="0" stopColor="#000" stopOpacity="0.26" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g clipPath={`url(#${uid}c)`}>
        <clipPath id={`${uid}c`}>
          <rect width="40" height="40" rx="12" />
        </clipPath>
        <rect width="40" height="40" fill={`url(#${uid}g)`} />
        <rect width="40" height="40" fill={`url(#${uid}d)`} />
        <rect width="40" height="40" fill={`url(#${uid}s)`} />
        {Glyph && (
          <g transform="translate(8 8)" color="#fff">
            <Glyph size={24} />
          </g>
        )}
      </g>
    </svg>
  );
}
