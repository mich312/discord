import React from 'react';
import { sealParams, arcPath } from '../lib/identicon.js';

// A member's seal: hue pair + arc pattern derived from the handle, initial
// set in the display serif. Purely computed — identity you can glance at.
export default function Seal({ name, size = 32, title }) {
  const { hue, hue2, rotate, bits } = sealParams(name);
  const c1 = `hsl(${hue} 42% 52%)`;
  const c2 = `hsl(${hue2} 46% 40%)`;
  const seg = 360 / bits.length;
  const letter = String(name ?? '?').slice(0, 1).toUpperCase();
  return (
    <svg
      className="seal-avatar"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={title ?? String(name)}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="20" cy="20" r="13.5" fill={c2} />
      <circle cx="20" cy="20" r="13.5" fill={`url(#seal-sheen)`} opacity="0.35" />
      <g stroke={c1} strokeWidth="2.6" fill="none" strokeLinecap="round" transform={`rotate(${rotate} 20 20)`}>
        {bits.map((on, i) =>
          on ? <path key={i} d={arcPath(20, 20, 17.4, i * seg + 3, (i + 1) * seg - 3)} /> : null
        )}
      </g>
      <text
        x="20"
        y="20"
        dy="0.36em"
        textAnchor="middle"
        fontFamily="Iowan Old Style, Palatino, Georgia, serif"
        fontSize="15"
        fontWeight="600"
        fill="rgba(255,252,245,0.92)"
      >
        {letter}
      </text>
      <defs>
        <radialGradient id="seal-sheen" cx="0.32" cy="0.25" r="0.9">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.25" />
        </radialGradient>
      </defs>
    </svg>
  );
}
