import React from 'react';
import { QuorumGlyph } from './icons.jsx';

// First paint before the identity is unlocked and circles decrypt: the brand
// mark breathing over an indeterminate bar. Not a spinner — it names what's
// happening (keys being derived, ciphertext opened) so the wait reads as
// work, not lag. Falls back to a still mark under reduced motion.
export default function BootLoader() {
  return (
    <div className="boot" data-testid="boot-loader">
      <div className="boot-mark">
        <QuorumGlyph size={40} />
      </div>
      <div className="boot-bar" aria-hidden="true">
        <span />
      </div>
      <div className="boot-label mono">decrypting your circles</div>
    </div>
  );
}
