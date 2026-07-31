import { useDialog } from '../lib/useDialog.js';
import React, { useEffect, useState } from 'react';
import { LinkGlyph, Key, ShieldCheck, Copy, Download, X, Check, AlertTriangle, Gear, LogOut } from './icons.jsx';

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
  onMismatch,
  onSecurePasskey,
  onSecurePassword,
  onSecureFile,
  onChannelSettings,
  onChannelRename,
  onChannelDelete,
  onRenameServer,
  onLeaveServer,
  onDeleteServer,
  onLogout,
  onLinkSend,
  onEnrollDevice,
  onListDevices,
  onRevokeDevice,
  unsecured,
  identityKey,
}) {
  const [linkSent, setLinkSent] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Channel settings drafts (seeded from the modal payload when open).
  const meta = modal.type === 'channel' ? modal.meta ?? {} : {};
  const [topic, setTopic] = useState(meta.topic ?? '');
  const [retention, setRetention] = useState(meta.retention ?? 0);
  const [renameTo, setRenameTo] = useState(modal.type === 'channel' ? modal.channel ?? '' : '');
  const [serverName, setServerName] = useState(modal.type === 'circle' ? modal.name ?? '' : '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Enrolled devices. `null` = not loaded yet, so an empty account and a
  // still-loading one do not render the same thing.
  const [devices, setDevices] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const showDevices = modal.type === 'secure' && !!onListDevices;
  useEffect(() => {
    if (!showDevices) return;
    let live = true;
    onListDevices()
      .then((list) => live && setDevices(list))
      // A relay that does not understand `passkey_wrap_list` is an older
      // relay, not a broken account: fall back to showing nothing rather
      // than an error the user cannot act on.
      .catch(() => live && setDevices([]));
    return () => {
      live = false;
    };
  }, [showDevices, onListDevices]);

  // Escape closes, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    circle: { glyph: <Gear />, title: modal.name ? `${modal.name} — circle settings` : 'Circle settings' },
    logout: { glyph: <LogOut />, title: 'Log out of this device' },
    'link-send': { glyph: <LinkGlyph />, title: 'Set up another device' },
    admin: { glyph: <ShieldCheck />, title: 'Relay admin overview' },
    channel: {
      glyph: <Gear />,
      title: modal.voice
        ? `${modal.channel ?? ''} — voice room`
        : `#${modal.channel ?? ''} settings`,
    },
  };
  const head = heads[modal.type];

  const dialog = useDialog(onClose, { label: head?.title ?? 'Dialog' });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal"
        ref={dialog.ref}
        {...dialog.props}
        onClick={(e) => e.stopPropagation()}
      >
        {head && (
          <div className="dialog-head">
            <span className="dialog-glyph">{head.glyph}</span>
            <h1>{head.title}</h1>
          </div>
        )}
        {modal.type === 'invite' && (
          <>
            <p className="muted">
              This link contains a secret key. Anyone with the full link can join, so
              send it only to people you trust.
            </p>
            <textarea className="keybox" readOnly value={modal.url} data-testid="invite-url" />
            <button className="button primary" onClick={() => copy(modal.url)} data-testid="copy-invite">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'copied' : 'copy link'}
            </button>
            <p className="fineprint muted">
              Anyone who has this link becomes a member. It expires in 7 days, and anyone
              who joins with it is marked <em>unverified</em> until someone checks their
              safety number.
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
              Passkeys are strongest. If you use a password, make it a long one.
            </p>
            {onEnrollDevice && (
              <>
                <div className="divider">just this device</div>
                <button
                  className="button wide"
                  disabled={busy}
                  data-testid="enroll-device"
                  onClick={() => attempt(onEnrollDevice)}
                >
                  <Key size={14} /> add one-tap for this device
                </button>
                <p className="fineprint muted">
                  Registers a passkey for this device only — your other devices&rsquo; passkeys keep
                  working. Best right after signing in on a new machine.
                </p>
              </>
            )}
            {showDevices && devices !== null && devices.length > 0 && (
              <>
                <div className="divider">devices that can sign in</div>
                <ul className="device-list" data-testid="device-list">
                  {devices.map((d) => (
                    <li key={d.credId} className="device-row">
                      <span className="device-name">
                        {d.label || 'unnamed device'}
                        <span className="device-when mono">
                          added {new Date(d.createdAt).toLocaleDateString()}
                        </span>
                      </span>
                      {confirmRevoke === d.credId ? (
                        <button
                          className="ghost danger"
                          disabled={busy}
                          data-testid={`device-revoke-confirm-${d.credId}`}
                          onClick={() =>
                            attempt(async () => {
                              await onRevokeDevice(d.credId);
                              setDevices((list) => list.filter((x) => x.credId !== d.credId));
                              setConfirmRevoke(null);
                            })
                          }
                        >
                          really revoke?
                        </button>
                      ) : (
                        <button
                          className="ghost"
                          disabled={busy}
                          data-testid={`device-revoke-${d.credId}`}
                          onClick={() => setConfirmRevoke(d.credId)}
                        >
                          revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {/* The limit stated where the button is, not in a help page.
                    "Revoke" reads as "cut that device off", and for a device
                    someone is holding, unlocked, it is not that. */}
                <p className="fineprint muted">
                  Revoking stops that passkey unlocking your account from now on. It cannot erase
                  what is already stored on a device someone is holding — if one was lost while
                  signed in, treat its messages as compromised.
                </p>
              </>
            )}
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
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'link-send' && (
          <>
            {!linkSent ? (
              <>
                <p className="muted">
                  A device wants to sign in as <strong>you</strong>. This hands it your
                  identity, sealed end to end — the server only ferries the bytes. Do it{' '}
                  <em>only</em> if you&rsquo;re the one setting up that device.
                </p>
                <p className="fineprint muted">
                  It should be showing the code{' '}
                  <strong className="mono">{modal.code}</strong> — check it matches before you send.
                </p>
                <button
                  className="button primary wide"
                  disabled={busy}
                  data-testid="link-send"
                  onClick={() =>
                    attempt(async () => {
                      await onLinkSend(modal.blobId, modal.pub);
                      setLinkSent(true);
                    })
                  }
                >
                  {busy ? 'sending…' : 'send my identity to it'}
                </button>
                <button className="button wide" onClick={onClose}>
                  cancel
                </button>
                {error && <p className="error" role="alert">{error}</p>}
              </>
            ) : (
              <p className="muted" data-testid="link-sent">
                Sent. Finish signing in on the other device — it&rsquo;ll ask you to confirm
                your handle.
              </p>
            )}
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
            {modal.mismatched ? (
              /* The outcome copy deliberately does not tell anyone to remove
                 and re-add the member "to force a new key". The safety number
                 is derived from both parties' MLS *signature* keys
                 (crypto-core `safety_number`), and a member's signer is
                 created once at account setup and carried in every KeyPackage
                 they ever publish — so a re-add produces a new leaf and the
                 same safety number. Sending someone who may be under attack
                 through a ritual that changes nothing is worse than saying
                 nothing. */
              <p className="error" role="alert" data-testid="safety-mismatch-note">
                Don’t send anything sensitive to <strong>{modal.peer}</strong> in this
                circle for now. A mismatch means the key you have for {modal.peer} isn’t
                the key they have. Usually that’s because they set up a new account — ask
                them, on a call or in person. If they did, compare again and the new
                numbers should match. If they didn’t, someone has put a different key in
                front of you. Removing {modal.peer} ends their access to this circle, but
                it can’t change their key — and nobody can change it for them.
              </p>
            ) : modal.verified ? (
              <p className="fineprint muted">already marked verified on this device.</p>
            ) : (
              /* Two outcomes, equally weighted. A dialog whose only button
                 grants trust is a consent funnel: the user who does the
                 comparison properly and finds it wrong had nothing to press. */
              <div className="safety-actions">
                <button
                  className="button primary"
                  data-testid="mark-verified"
                  onClick={() => onVerify(modal.server, modal.peer)}
                >
                  <Check size={14} />
                  they match
                </button>
                <button
                  className="button danger"
                  data-testid="mark-mismatch"
                  onClick={() => onMismatch(modal.server, modal.peer)}
                >
                  <AlertTriangle size={14} />
                  they don’t match
                </button>
              </div>
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
          <>
            {!modal.voice && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  attempt(async () => {
                    await onChannelSettings(modal.server, modal.channel, {
                      topic: topic.trim(),
                      retention: Number(retention) || 0,
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
                  This room&rsquo;s messages live on the relay, encrypted under a key
                  everyone in the circle holds — so anyone added later can read its
                  past, and the circle keeps it when you sign in somewhere new.
                  Auto-delete is how far back that reaches: the relay deletes
                  entries past it, which is the one bound on what the room key ever
                  unlocks.
                </p>
                <button className="button primary wide" disabled={busy} data-testid="channel-save">
                  {busy ? 'saving…' : 'save settings'}
                </button>
              </form>
            )}
            <div className="chan-manage">
              <label className="field">
                <span>rename {modal.voice ? 'voice room' : 'channel'}</span>
                <input
                  type="text"
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  data-testid="channel-rename-input"
                />
              </label>
              <div className="row">
                <button
                  type="button"
                  className="button"
                  data-testid="channel-rename"
                  disabled={busy || !renameTo.trim() || renameTo.trim() === modal.channel}
                  onClick={() =>
                    attempt(async () => {
                      await onChannelRename(modal.server, modal.channel, renameTo.trim(), !!modal.voice);
                      onClose();
                    })
                  }
                >
                  rename
                </button>
                <button
                  type="button"
                  className="button danger"
                  data-testid="channel-delete"
                  disabled={busy}
                  onClick={() => {
                    const ok = window.confirm(
                      modal.voice
                        ? `Delete the voice room "${modal.channel}" for everyone?`
                        : `Delete #${modal.channel} and its history for everyone? This can't be undone.`
                    );
                    if (!ok) return;
                    attempt(async () => {
                      await onChannelDelete(modal.server, modal.channel, !!modal.voice);
                      onClose();
                    });
                  }}
                >
                  delete {modal.voice ? 'voice room' : 'channel'}
                </button>
              </div>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
          </>
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
              your account, not your old messages.
            </p>
          </>
        )}
        {modal.type === 'circle' && (
          <>
            {modal.canManage ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  attempt(async () => {
                    await onRenameServer(modal.server, serverName.trim());
                    onClose();
                  });
                }}
              >
                <label className="field">
                  <span>circle name</span>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    data-testid="circle-rename-input"
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy || !serverName.trim() || serverName.trim() === modal.name}
                  data-testid="circle-rename"
                >
                  rename circle
                </button>
              </form>
            ) : (
              <p className="muted">
                Only an admin can rename or delete this circle. You can leave it below.
              </p>
            )}

            <div className="divider">leaving</div>
            <p className="fineprint muted">
              Leaving removes this circle from your account, not just from this device —
              your other devices drop it when they next reconnect. You&rsquo;ll need a new
              invite to come back; the others keep the circle.
            </p>
            <button
              className="button danger"
              data-testid="circle-leave"
              disabled={busy}
              onClick={() => {
                const ok = window.confirm(
                  `Leave "${modal.name}"? It will be removed from your account, on this device and your others.`
                );
                if (!ok) return;
                attempt(async () => {
                  await onLeaveServer(modal.server);
                  onClose();
                });
              }}
            >
              leave circle
            </button>

            {modal.canManage && (
              <>
                <div className="divider">danger zone</div>
                <p className="fineprint muted">
                  Deleting removes every member (their access is re-keyed away) and purges
                  the circle from the relay. This can&rsquo;t be undone.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.checked)}
                    data-testid="circle-delete-confirm"
                  />
                  I understand this deletes <strong>{modal.name}</strong> for everyone
                </label>
                <button
                  className="button danger wide"
                  data-testid="circle-delete"
                  disabled={busy || !confirmDelete}
                  onClick={() =>
                    attempt(async () => {
                      await onDeleteServer(modal.server);
                      onClose();
                    })
                  }
                >
                  {busy ? 'deleting…' : 'delete circle'}
                </button>
              </>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'logout' && (
          <>
            <p className="muted">
              Logging out wipes this browser&rsquo;s copy of your identity and its place in
              each circle, then returns to the sign-in screen.
            </p>
            {unsecured ? (
              <p className="error" role="alert" data-testid="logout-unsecured-warning">
                This account isn&rsquo;t secured yet — there is no passkey, password, or
                exported key. If you log out now it is gone <strong>for good</strong>.
              </p>
            ) : (
              <p className="fineprint muted">
                You&rsquo;ll need your passkey, password, or recovery/identity key to sign
                back in. Your circles and their messages do come back — they are kept on the
                relay, sealed. Sending doesn&rsquo;t: ask to be re-added for that.
              </p>
            )}
            <div className="row">
              <button
                className="button danger"
                data-testid="logout-confirm"
                disabled={busy}
                onClick={() => attempt(onLogout)}
              >
                <LogOut size={14} />
                {busy ? 'logging out…' : 'log out'}
              </button>
              <button className="button" data-testid="logout-cancel" onClick={onClose}>
                cancel
              </button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        <button className="ghost close" onClick={onClose} data-testid="close-modal" title="close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
