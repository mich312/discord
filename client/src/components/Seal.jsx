import React from 'react';
import { sealParams } from '../lib/identicon.js';

// A member's mark: a 5×5 mirrored module glyph computed from the handle —
// flat, sharp, machine-made. Identity here is a key, so the avatar is a
// fingerprint you can glance at, never a picture someone uploaded. The
// hue is the user's color everywhere (name, waveform, glow); the svg also
// exposes it as --uh so CSS effects around it can borrow the same color.
export default function Seal({ name, size = 32, title }) {
  const { hue, bits } = sealParams(name);
  const ink = `hsl(${hue} 52% 56%)`;
  // 15 bits fill the left three columns; the right two mirror them.
  const cells = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const src = col < 3 ? col : 4 - col;
      const bit = bits[(row * 3 + src) % bits.length] !== ((row + src) % 4 === 1);
      if (bit) cells.push([col, row]);
    }
  }
  return (
    <svg
      className="seal-avatar"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      role="img"
      aria-label={title ?? String(name)}
      style={{
        '--uh': hue,
        background: 'var(--well)',
        border: '1px solid var(--hairline-strong)',
      }}
    >
      {title ? <title>{title}</title> : null}
      {cells.map(([c, r]) => (
        <rect key={`${c}${r}`} x={2.5 + c * 3} y={2.5 + r * 3} width="3" height="3" fill={ink} />
      ))}
    </svg>
  );
}
