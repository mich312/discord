import React from 'react';
import { Lock, AlertTriangle } from './icons.jsx';
import { encryptionNote } from '../lib/encryption-note.js';
import { cx } from '../lib/cx.js';

/** The one encryption line under a conversation. It says whom it covers and,
    when something is outstanding, links to the fix. A key mismatch outranks
    everything and is shown in the danger colour, never as verified. */
export default function EncryptionNote({ server, me, onVerify, className }) {
  const note = encryptionNote(server, me);
  const mismatch = note.state === 'mismatch';
  const unchecked = note.state === 'unverified';
  const alone = note.state === 'alone';
  const Glyph = mismatch ? AlertTriangle : Lock;
  return (
    <div
      className={cx(
        'composer-note',
        unchecked && 'unchecked',
        mismatch && 'mismatch',
        alone && 'alone',
        className
      )}
      data-testid="composer-note"
      data-state={note.state}
    >
      <Glyph size={14} />
      <span>
        {note.text}
        {note.action && (
          <>
            {' · '}
            {onVerify ? (
              <button
                className="linkish"
                data-testid={mismatch ? 'composer-mismatch' : 'composer-unchecked'}
                onClick={onVerify}
              >
                {note.action}
              </button>
            ) : (
              note.action
            )}
          </>
        )}
      </span>
    </div>
  );
}
