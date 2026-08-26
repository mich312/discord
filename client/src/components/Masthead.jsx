import React from 'react';
import { QuorumGlyph, LinkGlyph, CommandGlyph, Sun, Moon } from './icons.jsx';
import Seal from './Seal.jsx';
import CircleMarker from './CircleMarker.jsx';
import { cx } from '../lib/cx.js';

// Full-width top bar: the brand at the left edge, the marker saying which
// circle and which room, and the session chrome — palette, theme, relay
// state, who you are signed in as — at the right. Nothing here scrolls;
// this is the fascia.
//
// There are no drawer toggles here any more. One opened the rail and the
// channel column; the other opened the roster. All three are gone as panels:
// rooms are the strip under this bar at every width, circles are a screen,
// and the circle's people are the first thing on its board.
export default function Masthead({
  server,
  channel,
  callChannel,
  game,
  call,
  now,
  onOpenCircle,
  connection,
  theme,
  canInvite,
  onInvite,
  onPalette,
  onTheme,
  me,
  onSettings,
}) {
  return (
    <header className="masthead">
      {/* The brand mark never leaves the fascia (§9.5) — but inside a circle
          the wordmark yields its width to the answer people actually need
          from this bar, which is which circle and which room. */}
      <div className={cx('masthead-brand', server && 'compact')}>
        <span className="brand-glyph">
          <QuorumGlyph />
        </span>
        <span className="wordmark">quorum</span>
      </div>
      {server && (
        <CircleMarker
          server={server}
          channel={channel}
          callChannel={callChannel}
          game={game}
          call={call}
          now={now}
          onOpenCircle={onOpenCircle}
        />
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
        {/* Going offline mid-conversation produced no announcement in any
            viewport, and below 820px `.conn-label` is hidden, which left a 7px
            coloured dot as the entire indicator — state carried by hue alone.
            role="status" announces the change; the dot carries a shape as well
            as a colour so it survives being unreadable. */}
        <span
          className="conn-chip"
          role="status"
          aria-live="polite"
          title={`relay: ${connection}`}
        >
          <span className={`conn-dot ${connection}`} data-testid="conn-dot" aria-hidden="true" />
          <span className="conn-label">relay·{connection}</span>
          <span className="sr-only">relay {connection}</span>
        </span>
        {/* Signed in as. The sidebar's self-card carried this, and it is the
            one thing on screen that says which account these keys belong to
            — so it moves to the fascia rather than to a screen you have to
            navigate to. It opens settings, where logging out now lives with
            room around it (§7.3). */}
        {me && (
          <button
            className="self-chip"
            data-testid="open-settings"
            title={`${me} — settings`}
            onClick={onSettings}
          >
            <Seal name={me} size={22} />
            <span className="self-chip-name" data-testid="self-name">
              {me}
            </span>
          </button>
        )}

      </div>
    </header>
  );
}
