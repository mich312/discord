import React, { useId } from 'react';
import { orbParams } from '../lib/avatar.js';

// A member's mark: a mesh-gradient orb computed from the handle — an anchor
// hue plus two derived hues, blurred into one wash. Identity here is a key,
// so the avatar is derived, never a picture someone uploaded; the same
// handle renders the same orb on every device.
export default function Seal({ name, size = 32, title }) {
  const id = useId();
  const { base, blobs } = orbParams(name);
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
      <defs>
        <clipPath id={`${id}c`}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
        <filter id={`${id}b`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5.5" />
        </filter>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect width="40" height="40" fill={base} />
        <g filter={`url(#${id}b)`}>
          {blobs.map((b, i) => (
            <circle key={i} cx={b.x} cy={b.y} r={b.r} fill={b.color} />
          ))}
        </g>
      </g>
    </svg>
  );
}
