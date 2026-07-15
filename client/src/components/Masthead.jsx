import React from 'react';
import { QuorumGlyph, LinkGlyph, CommandGlyph, Sun, Moon } from './icons.jsx';

// Full-width top bar: brand at the left edge, the current circle as a
// title (not a sidebar header), epoch as a visible artifact of the key
// schedule, and the session chrome (palette, theme, relay state) at the
// right. Nothing here scrolls; this is the instrument's fascia.
export default function Masthead({ server, connection, theme, onInvite, onPalette, onTheme }) {
  return (
    <header className="masthead">
      <div className="masthead-brand">
        <span className="brand-glyph">
          <QuorumGlyph />
        </span>
        <span className="wordmark">quorum</span>
      </div>
      {server && (
        <div className="masthead-context">
          <h1 className="circle-title" data-testid="server-name">{server.name}</h1>
          <span className="epoch-chip" title="key epoch — increments whenever membership changes">
            epoch {server.epoch}
          </span>
        </div>
      )}
      <div className="masthead-actions">
        {server && (
          <button className="button" data-testid="create-invite" title="create an invite link" onClick={onInvite}>
            <LinkGlyph />
            invite
          </button>
        )}
        <button className="palette-hint" title="command palette" onClick={onPalette}>
          <CommandGlyph />
          <span>go to…</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          className="icon-btn"
          title={theme === 'vellum' ? 'switch to obsidian (dark)' : 'switch to vellum (light)'}
          onClick={onTheme}
        >
          {theme === 'vellum' ? <Moon /> : <Sun />}
        </button>
        <span className="conn-chip" title={`relay: ${connection}`}>
          <span className={`conn-dot ${connection}`} data-testid="conn-dot" />
          {connection}
        </span>
      </div>
    </header>
  );
}
