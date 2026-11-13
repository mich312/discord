import React from 'react';
import { QuorumGlyph, LinkGlyph, Search, Sun, Moon, Wave, Mic, MicOff } from './icons.jsx';
import { describeCallLength } from '../lib/overview.js';
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
/** The connection, in words. Below 821px the word is the only thing the
    phone fascia has room for, so it is short. */
const CONNECTION_LABEL = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

export default function Masthead({
  server,
  channel,
  callChannel,
  game,
  call,
  now,
  onOpenCircle,
  onCircles,
  connection,
  theme,
  canInvite,
  onInvite,
  onPalette,
  onTheme,
  me,
  onSettings,
  // A call running somewhere the screen is not: on a phone it rides here as
  // a pill instead of in the call bar (CSS decides which shows).
  callPill = null,
  muted = false,
  onOpenCall,
}) {
  return (
    <header className="masthead">
      {/* The brand mark never leaves the fascia (§9.5) — but inside a circle
          the wordmark yields its width to the answer people actually need
          from this bar, which is which circle and which room. */}
      {/* And it is the way home: the list of your circles. A button, with
          a name that says where it goes — the glyph alone says "quorum". */}
      <button
        type="button"
        className={cx('masthead-brand', server && 'compact')}
        data-testid="masthead-home"
        aria-label="All your circles"
        title="All your circles"
        aria-current={server ? undefined : 'page'}
        onClick={onCircles}
      >
        <span className="brand-glyph">
          <QuorumGlyph />
        </span>
        <span className="wordmark">quorum</span>
      </button>
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
        {callPill && (
          <button
            className={cx('masthead-call', muted && 'muted')}
            data-testid="masthead-call"
            aria-label={`In a call in ${callPill.channel}, mic ${muted ? 'off' : 'on'}. Open call`}
            onClick={onOpenCall}
          >
            <Wave size={14} className="masthead-call-wave" />
            {muted ? <MicOff size={14} className="masthead-call-mic" /> : <Mic size={14} className="masthead-call-mic" />}
            <span>{describeCallLength(callPill.since, now)}</span>
          </button>
        )}
        {server && canInvite && (
          <button className="button" data-testid="create-invite" onClick={onInvite}>
            <LinkGlyph size={14} />
            Invite
          </button>
        )}
        <button
          className="palette-hint"
          data-testid="palette-hint"
          aria-label="Search or jump to (⌘K)"
          onClick={onPalette}
        >
          <Search size={14} />
          <span>Search or jump to</span>
          <kbd>⌘K</kbd>
        </button>
        {/* On a phone this lives in settings (CSS hides it below 821px —
            a preference, not a status, so §9.5 does not apply). */}
        <button
          className="icon-btn theme-btn"
          aria-label={theme === 'paper' ? 'Switch to dark theme' : 'Switch to light theme'}
          title={theme === 'paper' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={onTheme}
        >
          {theme === 'paper' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        {/* Going offline mid-conversation produced no announcement in any
            viewport, and below 820px `.conn-label` is hidden, which left a 7px
            coloured dot as the entire indicator — state carried by hue alone.
            role="status" announces the change; the dot carries a shape as well
            as a colour so it survives being unreadable. */}
        {/* §1.2 — a socket is not a key. The dot used to be green when
            online, the same green as a verified safety number, and coral
            while connecting. It is neutral while things are fine and only
            takes a colour, with its word, when they are not. */}
        <span className={cx('conn-chip', connection)} role="status" aria-live="polite">
          <span className={`conn-dot ${connection}`} data-testid="conn-dot" aria-hidden="true" />
          <span className="conn-label">{CONNECTION_LABEL[connection] ?? connection}</span>
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
            aria-label={`${me}: settings`}
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
