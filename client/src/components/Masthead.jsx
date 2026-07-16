import React from 'react';
import { QuorumGlyph, LinkGlyph, CommandGlyph, Sun, Moon, Menu, Users } from './icons.jsx';

// Full-width top bar: brand at the left edge, the current circle as a
// title (not a sidebar header), epoch as a visible artifact of the key
// schedule, and the session chrome (palette, theme, relay state) at the
// right. Nothing here scrolls; this is the instrument's fascia.
// On narrow screens the sidebar and roster become drawers; the menu and
// roster toggles below only render (via CSS) when that layout is active.
export default function Masthead({ server, connection, theme, canInvite, onInvite, onPalette, onTheme, onMenu, onRoster }) {
  return (
    <header className="masthead">
      <button className="icon-btn menu-btn" title="circles & rooms" data-testid="menu-toggle" onClick={onMenu}>
        <Menu />
      </button>
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
            EPOCH {String(server.epoch).padStart(2, '0')}
          </span>
        </div>
      )}
      <div className="masthead-actions">
        {server && canInvite && (
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
          title={theme === 'paper' ? 'switch to carbon (dark)' : 'switch to paper (light)'}
          onClick={onTheme}
        >
          {theme === 'paper' ? <Moon /> : <Sun />}
        </button>
        <span className="conn-chip" title={`relay: ${connection}`}>
          <span className={`conn-dot ${connection}`} data-testid="conn-dot" />
          <span className="conn-label">relay·{connection}</span>
        </span>
        {server && (
          <button className="icon-btn roster-btn" title="roster" data-testid="roster-toggle" onClick={onRoster}>
            <Users />
          </button>
        )}
      </div>
    </header>
  );
}
