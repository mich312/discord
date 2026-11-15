import React from 'react';
import { QuorumGlyph, LinkGlyph, Search, Wave, Mic, MicOff } from './icons.jsx';
import { describeCallLength } from '../lib/overview.js';
import Seal from './Seal.jsx';
import CircleMarker from './CircleMarker.jsx';
import { cx } from '../lib/cx.js';

// The top bar: brand, the circle you are in, then Invite, Search, the
// connection (shown only when it is not fine) and your account.

const CONNECTION_LABEL = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
};

const APPLE =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

/** A call's name for people: the room, or the other person in a direct call. */
function callName(channel, me) {
  if (!channel?.startsWith('dm:')) return channel;
  const pair = channel.slice(3).split('+');
  return pair.find((n) => n !== me) ?? pair[0];
}

export default function Masthead({
  server,
  game,
  now,
  onOpenCircle,
  onCircles,
  connection,
  canInvite,
  onInvite,
  onPalette,
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
      {/* The way home: the list of your circles. */}
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
        <CircleMarker server={server} game={game} onOpenCircle={onOpenCircle} />
      )}
      <div className="masthead-actions">
        {callPill && (
          <button
            className={cx('masthead-call', muted && 'muted')}
            data-testid="masthead-call"
            aria-label={`Open call: ${callName(callPill.channel, me)}, mic ${muted ? 'off' : 'on'}`}
            onClick={onOpenCall}
          >
            <Wave size={14} className="masthead-call-wave" />
            {muted ? <MicOff size={14} className="masthead-call-mic" /> : <Mic size={14} className="masthead-call-mic" />}
            <span>{describeCallLength(callPill.since, now)}</span>
          </button>
        )}
        {server && canInvite && (
          <button
            className="button masthead-invite"
            data-testid="create-invite"
            aria-label="Invite"
            onClick={onInvite}
          >
            <LinkGlyph size={14} />
            <span className="masthead-invite-label">Invite</span>
          </button>
        )}
        <button
          className="palette-hint"
          data-testid="palette-hint"
          aria-label="Search"
          onClick={onPalette}
        >
          <Search size={14} />
          <span>Search</span>
          <kbd>{APPLE ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {/* Always in the DOM so a change is announced; CSS hides it while
            online. The dot has a shape as well as a colour. */}
        <span className={cx('conn-chip', connection)} role="status" aria-live="polite">
          <span className={`conn-dot ${connection}`} data-testid="conn-dot" aria-hidden="true" />
          <span className="conn-label">{CONNECTION_LABEL[connection] ?? connection}</span>
        </span>
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
