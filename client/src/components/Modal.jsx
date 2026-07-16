import React, { useState } from 'react';
import { LinkGlyph, Key, ShieldCheck, Copy, Download, X, Check, Gear } from './icons.jsx';

const RETENTION_CHOICES = [
  { value: 0, label: 'keep until deleted by hand' },
  { value: 3600, label: 'after 1 hour' },
  { value: 86400, label: 'after 1 day' },
  { value: 7 * 86400, label: 'after 1 week' },
  { value: 30 * 86400, label: 'after 30 days' },
];

export default function Modal({
  modal,
  onClose,
  onVerify,
  onSecurePasskey,
  onSecurePassword,
  onSecureFile,
  onChannelSettings,
  identityKey,
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Channel settings drafts (seeded from the modal payload when open).
  const meta = modal.type === 'channel' ? modal.meta ?? {} : {};
  const [topic, setTopic] = useState(meta.topic ?? '');
  const [history, setHistory] = useState(!!meta.hid);
  const [retention, setRetention] = useState(meta.retention ?? 0);

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

  const heads = {
    invite: { glyph: <LinkGlyph />, title: 'Invite link' },
    secure: { glyph: <ShieldCheck />, title: 'Secure your account' },
    safety: { glyph: <ShieldCheck />, title: `Safety number — ${modal.peer ?? ''}` },
    identity: { glyph: <Key />, title: 'Identity key' },
    admin: { glyph: <ShieldCheck />, title: 'Relay admin overview' },
    channel: { glyph: <Gear />, title: `#${modal.channel ?? ''} settings` },
  };
  const head = heads[modal.type];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        {head && (
          <div className="dialog-head">
            <span className="dialog-glyph">{head.glyph}</span>
            <h1>{head.title}</h1>
          </div>
        )}
        {modal.type === 'invite' && (
          <>
            <p className="muted">
              The part after <code>#</code> is the decryption key — browsers never send it
              over the network, so the server stores an invite blob it cannot read.
            </p>
            <textarea className="keybox" readOnly value={modal.url} data-testid="invite-url" />
            <button className="button primary" onClick={() => copy(modal.url)} data-testid="copy-invite">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'copied' : 'copy link'}
            </button>
            <p className="fineprint muted">
              This link is a bearer token: whoever holds it becomes a member. It expires in
              7 days, dies if the blob goes stale while you're offline, and anyone who joins
              with it is marked <em>unverified</em> in the roster. Revoking it later
              only stops new joins — removing a member is what actually rotates the keys.
            </p>
          </>
        )}
        {modal.type === 'secure' && (
          <>
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
            <div className="divider">or a password</div>
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
            <div className="divider">or keep it manual</div>
            <a
              className="button"
              href={identityKey ? URL.createObjectURL(new Blob([identityKey], { type: 'text/plain' })) : '#'}
              download="identity.e2ee-key"
              data-testid="secure-file"
              onClick={() => onSecureFile()}
            >
              <Download size={14} />
              download key file
            </a>
            {error && <p className="error">{error}</p>}
          </>
        )}
        {modal.type === 'safety' && (
          <>
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
                className="button primary wide"
                data-testid="mark-verified"
                onClick={() => onVerify(modal.server, modal.peer)}
              >
                <Check size={14} />
                the numbers match — mark verified
              </button>
            )}
            <p className="fineprint muted">
              Verification is stored on this device only; it is your judgement, not the
              server's.
            </p>
          </>
        )}
        {modal.type === 'admin' && (
          <>
            <p className="muted">
              Everything the relay knows: registered handles and groups. Names,
              channels, and messages stay end-to-end encrypted — no admin can
              read them.
            </p>
            <div className="section-label">
              <span className="overline">users</span>
              <span className="member-count">{modal.users.length}</span>
            </div>
            <ul className="member-list" data-testid="admin-users">
              {modal.users.map((u) => (
                <li key={u} className="member"><span className="member-name">{u}</span></li>
              ))}
            </ul>
            <div className="section-label">
              <span className="overline">groups</span>
              <span className="member-count">{modal.groups.length}</span>
            </div>
            <ul className="member-list" data-testid="admin-groups">
              {modal.groups.map((g) => (
                <li key={g.group} className="member">
                  <span className="member-name">{g.group}</span>
                  <span className="tag muted">created by {g.created_by}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {modal.type === 'channel' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              attempt(async () => {
                await onChannelSettings(modal.server, modal.channel, {
                  topic: topic.trim(),
                  retention: Number(retention) || 0,
                  history,
                });
                onClose();
              });
            }}
          >
            <label className="field">
              <span>topic — shown at the top of the room</span>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="what this room is for"
                data-testid="channel-topic"
              />
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={history}
                onChange={(e) => setHistory(e.target.checked)}
                data-testid="channel-history"
              />
              <span>keep history for future joiners</span>
            </label>
            <p className="fineprint muted">
              On: messages are also sealed under a room key that travels inside the
              encryption to whoever is in the roster — new members and your own next
              device can read back. The relay still sees only ciphertext, but this
              deliberately gives up forward secrecy for this room: anyone admitted
              later can read what the key unlocks. Off: messages exist only on the
              devices that were present.
            </p>
            <label className="field">
              <span>auto-delete messages</span>
              <select
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                data-testid="channel-retention"
              >
                {RETENTION_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="fineprint muted">
              Auto-delete removes this room's messages from this device and the
              relay's history log. Other devices honor it when they next open the
              room — it is a shared setting, not a cryptographic guarantee.
            </p>
            <button className="button primary wide" disabled={busy} data-testid="channel-save">
              {busy ? 'saving…' : 'save settings'}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
        {modal.type === 'identity' && (
          <>
            <p className="muted">
              This string is your whole identity — the private key that signs your messages
              and logs you in. <strong>Anyone who has it is you.</strong>
            </p>
            <textarea className="keybox" readOnly value={modal.key ?? ''} data-testid="identity-key" />
            <div className="row">
              <button className="button primary" onClick={() => copy(modal.key)} data-testid="copy-identity">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'copied' : 'copy key'}
              </button>
              <a
                className="button"
                href={URL.createObjectURL(new Blob([modal.key ?? ''], { type: 'text/plain' })) }
                download="identity.e2ee-key"
                data-testid="download-identity"
              >
                <Download size={14} />
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
        <button className="ghost close" onClick={onClose} data-testid="close-modal" title="close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
