import React from 'react';
import { QuorumGlyph } from './icons.jsx';

// First paint before the identity is unlocked: the brand mark over an
// indeterminate bar. Falls back to a still mark under reduced motion.
export default function BootLoader() {
  return (
    <div className="boot" data-testid="boot-loader">
      <div className="boot-mark">
        <QuorumGlyph size={40} />
      </div>
      <div className="boot-bar" aria-hidden="true">
        <span />
      </div>
      <div className="boot-label" role="status">Loading…</div>
    </div>
  );
}
