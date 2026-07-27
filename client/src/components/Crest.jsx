// PROTOTYPE — a circle's tile mark.
//
// Three states, in order of preference: a chosen crest glyph over the derived
// hue; the derived geometric mark alone; and the monogram we ship today. The
// point of the fallback chain is that a circle has a face the moment it is
// created — nobody has to configure anything for the rail to be legible.
import React, { useId } from 'react';
import { crestParams } from '../lib/crest.js';

export default function Crest({ id, name, size = 44, glyph: Glyph = null, mark = true }) {
  const uid = useId();
  const { from, to, division, charge } = crestParams(id);
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
        <linearGradient id={`${uid}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
        {/* the tile's own rounded shape, so a division can run edge to edge
            without squaring off the corners */}
        <clipPath id={`${uid}r`}>
          <rect width="40" height="40" rx="12" />
        </clipPath>
      </defs>
      <rect width="40" height="40" rx="12" fill={`url(#${uid}g)`} />
      {mark && !Glyph && (
        <g clipPath={`url(#${uid}r)`}>
          {division && <path d={division} fill="#fff" fillOpacity="0.2" />}
          {charge === 'roundel' && (
            <circle cx="20" cy="20" r="7.5" fill="#fff" fillOpacity="0.3" />
          )}
          {charge === 'bar' && (
            <rect x="8" y="17" width="24" height="6" rx="3" fill="#fff" fillOpacity="0.3" />
          )}
        </g>
      )}
      {Glyph && (
        // The glyph sits on a slightly darkened plate so it holds against
        // whichever end of the gradient it lands on.
        <g>
          <rect width="40" height="40" rx="12" fill="#000" fillOpacity="0.18" />
          <g transform="translate(8 8)" color="#fff">
            <Glyph size={24} />
          </g>
        </g>
      )}
    </svg>
  );
}
