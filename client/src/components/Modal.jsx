import { useDialog } from '../lib/useDialog.js';
import React, { useEffect, useState } from 'react';
import { Key, Copy, Download, X, Check, AlertTriangle, LogOut, ShieldCheck } from './icons.jsx';
import CircleMark from './CircleMark.jsx';
import { CIRCLE_GLYPH_KEYS, DEFAULT_GLYPH } from '../lib/crest.js';
import { normalizeThreshold } from '../lib/quorum.js';
import { cx } from '../lib/cx.js';
import { errorText } from '../lib/fail-text.js';

const RETENTION_CHOICES = [
  { value: 0, label: 'Never' },
  { value: 3600, label: 'After 1 hour' },
  { value: 86400, label: 'After 1 day' },
  { value: 7 * 86400, label: 'After 1 week' },
  { value: 30 * 86400, label: 'After 30 days' },
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
  onSetGlyph,
  onSetThreshold,
  onLeaveServer,
  onDeleteServer,
  onAdminDeleteGroup,
  onLogout,
  onLinkSend,
  onEnrollDevice,
  onListDevices,
  onRevokeDevice,
  onSecure,
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
  // How many signatures this circle asks for before it lets somebody in.
  const memberCount = modal.type === 'circle' ? modal.members ?? 1 : 1;
  const [threshold, setThreshold] = useState(() =>
    modal.type === 'circle' ? normalizeThreshold(modal.threshold, memberCount) : 2
  );
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function share(url) {
    try {
      await navigator.share({ url });
    } catch {
      // Cancelled, or the share sheet failed: the link is still on screen.
    }
  }

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

  const titles = {
    invite: 'Invite link',
    secure: 'Back up your account',
    safety: `Verify ${modal.peer ?? ''}`,
    identity: 'Identity key',
    circle: 'Circle settings',
    logout: 'Log out',
    'link-send': 'Set up another device',
    admin: 'Admin overview',
    channel: modal.voice ? `${modal.channel ?? ''} settings` : `#${modal.channel ?? ''} settings`,
  };
  const title = titles[modal.type];

  const dialog = useDialog(onClose, { label: title ?? 'Dialog' });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal"
        ref={dialog.ref}
        {...dialog.props}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="dialog-head">
            <h1>{title}</h1>
          </div>
        )}
        {modal.type === 'invite' && (
          <>
            <p className="muted">Anyone with this link can join and read past messages.</p>
            {/* Mono and single-line: the link carries the circle's key. */}
            <input
              className="keybox invite-link"
              readOnly
              value={modal.url}
              aria-label="Invite link"
              onFocus={(e) => e.target.select()}
              data-testid="invite-url"
            />
            <div className="row">
              <button className="button primary" onClick={() => copy(modal.url)} data-testid="copy-invite">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {canShare && (
                <button className="button" onClick={() => share(modal.url)} data-testid="share-invite">
                  Share
                </button>
              )}
            </div>
            <p className="fineprint muted">Works for 7 days.</p>
          </>
        )}
        {modal.type === 'secure' && (
          <>
            <p className="muted">
              {unsecured
                ? 'Your key is only on this device. If you lose it without a backup, you lose the account.'
                : 'Your account is backed up. You can add another way to sign in.'}
            </p>
            <button
              className="button primary wide"
              disabled={busy}
              data-testid="secure-passkey"
              onClick={() => attempt(onSecurePasskey)}
            >
              Use passkey
            </button>
            <div className="divider">or</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                attempt(() => onSecurePassword(password));
              }}
            >
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="secure-password-hint"
                  data-testid="secure-password"
                />
              </label>
              <p className="fineprint muted" id="secure-password-hint">
                At least 8 characters.
              </p>
              <button className="button" disabled={busy} data-testid="secure-password-submit">
                {busy ? 'Backing up…' : 'Use password'}
              </button>
            </form>
            {onEnrollDevice && (
              <>
                <div className="divider">This device</div>
                <button
                  className="button wide"
                  disabled={busy}
                  data-testid="enroll-device"
                  onClick={() => attempt(onEnrollDevice)}
                >
                  <Key size={14} /> Add this device
                </button>
                <p className="fineprint muted">Adds a passkey for this device only.</p>
              </>
            )}
            {showDevices && devices !== null && devices.length > 0 && (
              <>
                <div className="divider">Devices</div>
                <ul className="device-list" data-testid="device-list">
                  {devices.map((d) => (
                    <li key={d.credId} className="device-row">
                      <span className="device-name">
                        {d.label || 'Unnamed device'}
                        <span className="device-when">
                          Added {new Date(d.createdAt).toLocaleDateString()}
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
                          Confirm
                        </button>
                      ) : (
                        <button
                          className="ghost"
                          disabled={busy}
                          data-testid={`device-revoke-${d.credId}`}
                          onClick={() => setConfirmRevoke(d.credId)}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {/* The limit, stated beside the button: removing a passkey
                    does not sign out a device that is already signed in. */}
                <p className="fineprint muted">
                  This stops new sign-ins. It doesn&rsquo;t sign out a device that&rsquo;s already
                  signed in.
                </p>
              </>
            )}
            <div className="divider">Key file</div>
            <a
              className="button"
              href={identityKey ? URL.createObjectURL(new Blob([identityKey], { type: 'text/plain' })) : '#'}
              download="identity.e2ee-key"
              data-testid="secure-file"
              onClick={() => onSecureFile()}
            >
              <Download size={14} />
              Download
            </a>
            <p className="fineprint muted">Not password-protected. Anyone with the file can sign in as you.</p>
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'link-send' && (
          <>
            {!linkSent ? (
              <>
                <p className="muted">
                  Only continue if you&rsquo;re setting up that device yourself.
                </p>
                <p className="fineprint muted">
                  The other device should show <strong className="mono">{modal.code}</strong>.
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
                  {busy ? 'Sending…' : 'Send key'}
                </button>
                <button className="button wide" onClick={onClose}>
                  Cancel
                </button>
                {error && <p className="error" role="alert">{error}</p>}
              </>
            ) : (
              <p className="muted" data-testid="link-sent">
                Sent. Finish on the other device.
              </p>
            )}
          </>
        )}
        {modal.type === 'safety' && (
          <>
            <p className="muted">
              Compare these numbers with {modal.peer} in person or on a call.
            </p>
            <div className="safety-number" data-testid="safety-number">
              {modal.number.split(' ').map((group, i) => (
                <span key={i} className="mono">{group}</span>
              ))}
            </div>
            {!modal.mismatched && !modal.verified && (
              <p className="fineprint muted">If they match, nobody swapped your keys. Saved on this device only.</p>
            )}
            {modal.mismatched ? (
              /* No "remove and re-add" advice: a re-add keeps the same
                 signature key, so the safety number would not change. */
              <p className="error" role="alert" data-testid="safety-mismatch-note">
                Don&rsquo;t send <strong>{modal.peer}</strong> anything sensitive. Check on a call
                if they made a new account.
              </p>
            ) : modal.verified ? (
              <p className="fineprint muted">Already verified on this device.</p>
            ) : (
              /* Two outcomes, equally weighted (§10.4). */
              <div className="safety-actions">
                <button
                  className="button"
                  data-testid="mark-verified"
                  onClick={() => onVerify(modal.server, modal.peer)}
                >
                  <Check size={14} />
                  They match
                </button>
                <button
                  className="button"
                  data-testid="mark-mismatch"
                  onClick={() => onMismatch(modal.server, modal.peer)}
                >
                  <AlertTriangle size={14} />
                  They don’t match
                </button>
              </div>
            )}
          </>
        )}
        {modal.type === 'admin' && (
          <>
            <p className="muted">Circles you&rsquo;re not in show by ID.</p>
            <div className="section-label">
              <span className="overline">Users</span>
              <span className="member-count">{modal.users.length}</span>
            </div>
            <ul className="member-list" data-testid="admin-users">
              {modal.users.map((u) => (
                <li key={u} className="member"><span className="member-name">{u}</span></li>
              ))}
            </ul>
            <div className="section-label">
              <span className="overline">Circles</span>
              <span className="member-count">{modal.groups.length}</span>
            </div>
            <ul className="member-list" data-testid="admin-groups">
              {modal.groups.map((g) => (
                <li key={g.group} className="member" data-testid={`admin-group-${g.group}`}>
                  <span className="member-name">
                    {modal.names?.[g.group] ? `${modal.names[g.group]} · ${g.group}` : g.group}
                  </span>
                  <span className="tag muted">created by {g.created_by}</span>
                  <button
                    className="ghost member-remove danger"
                    data-testid={`admin-delete-${g.group}`}
                    aria-label={`Delete ${modal.names?.[g.group] ?? g.group} for everyone`}
                    title="Delete for everyone"
                    disabled={busy}
                    onClick={() => {
                      const ok = window.confirm(
                        `Delete "${modal.names?.[g.group] ?? g.group}" for everyone in it? This can't be undone.`
                      );
                      if (ok) attempt(() => onAdminDeleteGroup(g.group));
                    }}
                  >
                    Delete
                  </button>
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
                  <span>Topic</span>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    data-testid="channel-topic"
                  />
                </label>
                <label className="field">
                  <span>Auto-delete messages</span>
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
                {/* The history fact the room header no longer carries. */}
                <p className="fineprint muted">
                  New members can read this room&rsquo;s history. Auto-delete removes old messages
                  for everyone.
                </p>
                <button className="button primary wide" disabled={busy} data-testid="channel-save">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </form>
            )}
            <div className="chan-manage">
              <label className="field">
                <span>Name</span>
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
                  Rename
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
                  Delete {modal.voice ? 'voice room' : 'room'}
                </button>
              </div>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'identity' && (
          <>
            <p className="muted">
              <strong>Anyone with this key can act as you.</strong>
            </p>
            <textarea className="keybox" readOnly value={modal.key ?? ''} data-testid="identity-key" />
            <div className="row">
              <button className="button primary" onClick={() => copy(modal.key)} data-testid="copy-identity">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <a
                className="button"
                href={URL.createObjectURL(new Blob([modal.key ?? ''], { type: 'text/plain' })) }
                download="identity.e2ee-key"
                data-testid="download-identity"
              >
                <Download size={14} />
                Download
              </a>
            </div>
            <p className="fineprint muted">To sign in elsewhere, paste it on the sign-in screen.</p>
          </>
        )}
        {modal.type === 'circle' && (
          <>
            {modal.canManage && (
              <>
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
                  <span>Circle name</span>
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
                  Rename
                </button>
              </form>
                <fieldset className="glyph-picker">
                  {/* A real fieldset/legend: one choice, heard as a question (§8.7). */}
                  <legend>Icon</legend>
                  <div className="glyph-options">
                    {CIRCLE_GLYPH_KEYS.map((key) => {
                      const on = (modal.glyph ?? DEFAULT_GLYPH) === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={cx('glyph-option', on && 'on')}
                          // §7.9 — the visual state needs an ARIA one beside
                          // it; `.on` tells assistive tech nothing.
                          aria-pressed={on}
                          disabled={busy || on}
                          data-testid={`circle-glyph-${key}`}
                          onClick={() =>
                            attempt(async () => {
                              await onSetGlyph(modal.server, key);
                            })
                          }
                        >
                          <CircleMark id={modal.server} name="" glyph={key} size={36} />
                          <span>{key}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="divider">New members</div>
                <p className="fineprint muted">Signatures needed to add someone by handle. Invite links skip this.</p>
                <div className="threshold-picker">
                  <label className="threshold-label" htmlFor="circle-threshold">
                    Signatures needed
                  </label>
                  <div className="threshold-row">
                  <input
                    id="circle-threshold"
                    type="number"
                    min={memberCount === 1 ? 1 : 2}
                    max={memberCount}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    data-testid="circle-threshold-input"
                  />
                  <span className="muted">of {memberCount}</span>
                  <button
                    className="button"
                    type="button"
                    disabled={
                      busy ||
                      normalizeThreshold(threshold, memberCount) ===
                        normalizeThreshold(modal.threshold, memberCount)
                    }
                    data-testid="circle-threshold-save"
                    onClick={() =>
                      attempt(async () => {
                        await onSetThreshold(
                          modal.server,
                          normalizeThreshold(threshold, memberCount)
                        );
                        onClose();
                      })
                    }
                  >
                    Save
                  </button>
                  </div>
                </div>
                <div className="divider" role="separator" />
              </>
            )}

            <button
              className="button danger"
              data-testid="circle-leave"
              disabled={busy}
              onClick={() => {
                const ok = window.confirm(
                  `Leave "${modal.name}"? You’ll need a new invite to come back.`
                );
                if (!ok) return;
                attempt(async () => {
                  await onLeaveServer(modal.server);
                  onClose();
                });
              }}
            >
              Leave circle
            </button>

            {modal.canManage && (
              <>
                <div className="divider" role="separator" />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.checked)}
                    data-testid="circle-delete-confirm"
                  />
                  <span>
                    I understand this deletes <strong>{modal.name}</strong> for everyone
                  </span>
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
                  {busy ? 'Deleting…' : 'Delete circle'}
                </button>
              </>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'logout' && (
          <>
            {unsecured ? (
              <p className="error" role="alert" data-testid="logout-unsecured-warning">
                Your key isn&rsquo;t backed up. If you log out, you can&rsquo;t sign back in.
              </p>
            ) : (
              <p className="muted">
                You&rsquo;ll need your passkey, password, recovery file or key file to sign back in.
              </p>
            )}
            <div className="row">
              {unsecured && onSecure && (
                <button className="button primary" data-testid="logout-secure" onClick={onSecure}>
                  <ShieldCheck size={14} />
                  Back up first
                </button>
              )}
              <button
                className="button danger"
                data-testid="logout-confirm"
                disabled={busy}
                onClick={() => attempt(onLogout)}
              >
                <LogOut size={14} />
                {busy ? 'Logging out…' : 'Log out'}
              </button>
              <button className="button" data-testid="logout-cancel" onClick={onClose}>
                Cancel
              </button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        <button className="ghost close" onClick={onClose} data-testid="close-modal" aria-label="Close" title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
