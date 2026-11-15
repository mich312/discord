import React from 'react';
import { circleFill } from '../lib/crest.js';
import { initialOf } from '../lib/avatar.js';

// A member's mark: their initial, white, on a solid circle in a colour
// derived from the handle. The same handle renders the same mark on every
// device. Below 20px there is no room for a legible letter, so it is the
// circle alone.
export default function Seal({ name, size = 32, title }) {
  const handle = String(name ?? '?');
  return (
    <svg
      className="seal-avatar"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label={title ?? handle}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="20" cy="20" r="20" fill={circleFill(handle)} />
      {size >= 20 && (
        <text
          x="20"
          y="20"
          dy=".35em"
          textAnchor="middle"
          fontSize="17"
          fontWeight="600"
          fill="#fff"
        >
          {initialOf(handle)}
        </text>
      )}
    </svg>
  );
}
