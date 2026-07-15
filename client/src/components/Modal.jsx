import React, { useState } from 'react';

export default function Modal({
  modal,
  onClose,
  onVerify,
  onSecurePasskey,
  onSecurePassword,
  onSecureFile,
  identityKey,
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function attempt(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const [copied, setCopied] = useState(false);

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be unavailable (permissions/headless); the text is
      // selectable either way.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        {modal.type === 'invite' && (
          <>
            <h1>invite link</h1>
            <p className="muted">
              The part after <code>#</code> is the decryption key — browsers never send it
              over the network, so the server stores an invite blob it cannot read.
            </p>
            <textarea className="keybox" readOnly value={modal.url} data-testid="invite-url" />
            <button className="button primary" onClick={() => copy(modal.url)} data-testid="copy-invite">
              {copied ? 'copied' : 'copy link'}
            </button>
            <p className="fineprint muted">
              This link is a bearer token: whoever holds it becomes a member. It expires in
              7 days, dies if the blob goes stale while you're offline, and anyone who joins
              with it is marked <em>unverified</em> in the member list. Revoking it later
              only stops new joins — removing a member is what actually rotates the keys.
            </p>
          </>
        )}
        {modal.type === 'secure' && (
          <>
            <h1>secure your account</h1>
            <p className="muted">
              Your identity key lives only in this browser right now. Park an{' '}
              <em>encrypted</em> copy on the server so you can sign in elsewhere — the
              server can never read it.
            </p>
            <button
              className="button primary wide"
              disabled={busy}
              data-testid="secure-passkey"
              onClick={() => attempt(onSecurePasskey)}
            >
              use a passkey (recommended)
            </button>
            <div className="divider muted">or a password</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                attempt(() => onSecurePassword(password));
              }}
            >
              <label className="field">
                <span>password (8+ chars — longer is safer)</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="secure-password"
                />
              </label>
              <button className="button" disabled={busy} data-testid="secure-password-submit">
                {busy ? 'deriving keys…' : 'secure with password'}
              </button>
            </form>
            <p className="fineprint muted">
              Passkeys leave nothing to brute-force. With a password, the server could try
              to guess a <em>weak</em> one offline against the encrypted copy — pick a real
              passphrase.
            </p>
            <div className="divider muted">or keep it manual</div>
            <a
              className="button"
              href={identityKey ? URL.createObjectURL(new Blob([identityKey], { type: 'text/plain' })) : '#'}
              download="identity.e2ee-key"
              data-testid="secure-file"
              onClick={() => onSecureFile()}
            >
              download key file
            </a>
            {error && <p className="error">{error}</p>}
          </>
        )}
        {modal.type === 'safety' && (
          <>
            <h1>safety number — {modal.peer}</h1>
            <p className="muted">
              Compare these digits with {modal.peer} over a channel you already trust (in
              person, a call). If they match, nobody — including the relay — has swapped
              keys on either of you.
            </p>
            <div className="safety-number" data-testid="safety-number">
              {modal.number.split(' ').map((group, i) => (
                <span key={i} className="mono">{group}</span>
              ))}
            </div>
            {modal.verified ? (
              <p className="fineprint muted">already marked verified on this device.</p>
            ) : (
              <button
                className="button primary"
                data-testid="mark-verified"
                onClick={() => onVerify(modal.server, modal.peer)}
              >
                the numbers match — mark verified
              </button>
            )}
            <p className="fineprint muted">
              Verification is stored on this device only; it is your judgement, not the
              server's.
            </p>
          </>
        )}
        {modal.type === 'identity' && (
          <>
            <h1>identity key</h1>
            <p className="muted">
              This string is your whole identity — the private key that signs your messages
              and logs you in. <strong>Anyone who has it is you.</strong>
            </p>
            <textarea className="keybox" readOnly value={modal.key ?? ''} data-testid="identity-key" />
            <div className="row">
              <button className="button primary" onClick={() => copy(modal.key)} data-testid="copy-identity">
                {copied ? 'copied' : 'copy key'}
              </button>
              <a
                className="button"
                href={URL.createObjectURL(new Blob([modal.key ?? ''], { type: 'text/plain' })) }
                download="identity.e2ee-key"
                data-testid="download-identity"
              >
                download
              </a>
            </div>
            <p className="fineprint muted">
              Unlike the recovery file, this export is NOT passphrase-protected. Paste it
              into “restore → identity key” on another device to sign in there. It restores
              your account, not old group keys.
            </p>
          </>
        )}
        <button className="ghost close" onClick={onClose} data-testid="close-modal">
          close
        </button>
      </div>
    </div>
  );
}
