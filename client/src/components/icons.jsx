import React from 'react';

// Hand-drawn 16px stroke icon set — no icon-font, no CDN, currentColor
// throughout so every glyph inherits the text register around it.
const Svg = ({ size = 16, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

// Brand: a registration mark holding three modules — the smallest quorum.
export const QuorumGlyph = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" />
    <rect x="6.5" y="6.5" width="4.4" height="4.4" fill="currentColor" stroke="none" />
    <rect x="13.1" y="6.5" width="4.4" height="4.4" fill="currentColor" stroke="none" />
    <rect x="9.8" y="13.1" width="4.4" height="4.4" fill="currentColor" stroke="none" />
  </svg>
);

export const Lock = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    <circle cx="8" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

export const Key = (p) => (
  <Svg {...p}>
    <circle cx="5" cy="11" r="2.8" />
    <path d="M7.2 8.8 13 3M10.5 5.5l1.8 1.8M8.7 7.3l1.4 1.4" />
  </Svg>
);

export const ShieldCheck = (p) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6v-4L8 1.8Z" />
    <path d="m5.8 7.8 1.6 1.6 2.8-3" />
  </Svg>
);

export const Hash = (p) => (
  <Svg {...p}>
    <path d="M6.2 2.5 4.8 13.5M11.2 2.5 9.8 13.5M3 6h10.5M2.5 10H13" />
  </Svg>
);

export const Wave = (p) => (
  <Svg {...p}>
    <path d="M2.5 6.5v3M5.3 4.5v7M8 2.8v10.4M10.7 4.5v7M13.5 6.5v3" />
  </Svg>
);

export const Mic = (p) => (
  <Svg {...p}>
    <rect x="6" y="1.8" width="4" height="8" rx="2" />
    <path d="M3.7 7.5a4.3 4.3 0 0 0 8.6 0M8 11.8v2.4" />
  </Svg>
);

export const MicOff = (p) => (
  <Svg {...p}>
    <rect x="6" y="1.8" width="4" height="8" rx="2" />
    <path d="M3.7 7.5a4.3 4.3 0 0 0 8.6 0M8 11.8v2.4" />
    <path d="M2.3 2.3l11.4 11.4" />
  </Svg>
);

// Headphones — the deafen glyph: a headband arc over two earcups.
export const Headphone = (p) => (
  <Svg {...p}>
    <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" />
    <rect x="2.2" y="9" width="2.8" height="4.2" rx="1.1" />
    <rect x="11" y="9" width="2.8" height="4.2" rx="1.1" />
  </Svg>
);

export const HeadphoneOff = (p) => (
  <Svg {...p}>
    <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" />
    <rect x="2.2" y="9" width="2.8" height="4.2" rx="1.1" />
    <rect x="11" y="9" width="2.8" height="4.2" rx="1.1" />
    <path d="M2.3 2.3l11.4 11.4" />
  </Svg>
);

export const Plus = (p) => (
  <Svg {...p}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Svg>
);

export const Gear = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.5M8 12.9v1.5M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M1.6 8h1.5M12.9 8h1.5M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1" />
  </Svg>
);

// A door with an arrow leaving through it — sign out.
export const LogOut = (p) => (
  <Svg {...p}>
    <path d="M6 2H3.6A1.6 1.6 0 0 0 2 3.6v8.8A1.6 1.6 0 0 0 3.6 14H6" />
    <path d="M10.4 11 13.5 8l-3.1-3" />
    <path d="M13.5 8H6" />
  </Svg>
);

export const Phone = (p) => (
  <Svg {...p}>
    <g transform="scale(0.667)">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </g>
  </Svg>
);

export const LinkGlyph = (p) => (
  <Svg {...p}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7.5 4.6l1.2-1.2a2.6 2.6 0 0 1 3.9 3.9L11.4 8.5M8.5 11.4l-1.2 1.2a2.6 2.6 0 0 1-3.9-3.9l1.2-1.2" />
  </Svg>
);

export const Bell = (p) => (
  <Svg {...p}>
    <path d="M8 2.2a4 4 0 0 1 4 4c0 3 .8 4 1.4 4.6H2.6C3.2 10.2 4 9.2 4 6.2a4 4 0 0 1 4-4Z" />
    <path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0" />
  </Svg>
);

export const CommandGlyph = (p) => (
  <Svg {...p}>
    <path d="M6 6h4v4H6z" />
    <path d="M6 6H4.8A1.8 1.8 0 1 1 6 4.2V6ZM10 6V4.8A1.8 1.8 0 1 1 11.8 6H10ZM10 10h1.8a1.8 1.8 0 1 1-1.8 1.8V10ZM6 10v1.8A1.8 1.8 0 1 1 4.2 10H6Z" />
  </Svg>
);

export const Sun = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
  </Svg>
);

export const Moon = (p) => (
  <Svg {...p}>
    <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z" />
  </Svg>
);

export const Copy = (p) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.2A1.3 1.3 0 0 0 9.2 2H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h.2" />
  </Svg>
);

export const Download = (p) => (
  <Svg {...p}>
    <path d="M8 2.5v7M5 6.8 8 9.8l3-3M2.8 12.5h10.4" />
  </Svg>
);

export const Paperclip = (p) => (
  <Svg {...p}>
    <path d="m12.4 7.3-4.6 4.6a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8L6.7 10.2a1 1 0 0 1-1.4-1.4l4.3-4.3" />
  </Svg>
);

export const Check = (p) => (
  <Svg {...p}>
    <path d="m3 8.5 3.2 3.2L13 5" />
  </Svg>
);

export const Menu = (p) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);

export const Users = (p) => (
  <Svg {...p}>
    <circle cx="5.8" cy="5.5" r="2.3" />
    <path d="M1.8 13.2c.4-2.4 2-3.7 4-3.7s3.6 1.3 4 3.7" />
    <path d="M10.2 3.6a2.3 2.3 0 0 1 0 3.9M11.6 9.8c1.4.4 2.3 1.6 2.6 3.4" />
  </Svg>
);

export const X = (p) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const Screen = (p) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1" />
    <path d="M5.6 13.6h4.8M8 11.2v2.4" />
  </Svg>
);

export const Clock = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 4.8V8l2.2 1.6" />
  </Svg>
);

export const ArrowRight = (p) => (
  <Svg {...p}>
    <path d="M2.5 8h11M9.5 4l4 4-4 4" />
  </Svg>
);

export const CircleGlyph = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);

export const Gamepad = (p) => (
  <Svg {...p}>
    <path d="M4.6 4.6h6.8a3.4 3.4 0 0 1 3.3 4.1l-.5 2.4a1.9 1.9 0 0 1-3.3.9l-1-1.2H6.1l-1 1.2a1.9 1.9 0 0 1-3.3-.9l-.5-2.4a3.4 3.4 0 0 1 3.3-4.1Z" />
    <path d="M5.4 7v2M4.4 8h2" />
    <circle cx="10.4" cy="7.4" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="11.8" cy="8.8" r="0.7" fill="currentColor" stroke="none" />
  </Svg>
);

export const External = (p) => (
  <Svg {...p}>
    <path d="M6.5 3.5H4.2A1.7 1.7 0 0 0 2.5 5.2v6.6a1.7 1.7 0 0 0 1.7 1.7h6.6a1.7 1.7 0 0 0 1.7-1.7V9.5" />
    <path d="M9.5 2.5h4v4M13.2 2.8 7.5 8.5" />
  </Svg>
);

export const Seal8 = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <circle cx="8" cy="8" r="2.6" />
    <path d="M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2" strokeWidth="1.1" />
  </Svg>
);
