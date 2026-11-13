import { useDialog } from '../lib/useDialog.js';
import React, { useEffect, useState } from 'react';
import { LinkGlyph, Key, ShieldCheck, Copy, Download, X, Check, AlertTriangle, Gear, LogOut } from './icons.jsx';
import CircleMark from './CircleMark.jsx';
import { CIRCLE_GLYPH_KEYS, DEFAULT_GLYPH } from '../lib/crest.js';
import { normalizeThreshold } from '../lib/quorum.js';
import { cx } from '../lib/cx.js';

const RETENTION_CHOICES = [
  { value: 0, label: 'Keep until deleted by hand' },
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
    safety: { glyph: <ShieldCheck />, title: `Verify ${modal.peer ?? ''}` },
    identity: { glyph: <Key />, title: 'Identity key' },
    circle: { glyph: <Gear />, title: modal.name ? `${modal.name} settings` : 'Circle settings' },
    logout: { glyph: <LogOut />, title: 'Log out of this device' },
    'link-send': { glyph: <LinkGlyph />, title: 'Set up another device' },
    admin: { glyph: <ShieldCheck />, title: 'Server admin overview' },
    channel: {
      glyph: <Gear />,
      title: modal.voice
        ? `${modal.channel ?? ''} settings`
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
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {/* §10.10 — the history disclosure belongs here, at the moment it
                takes effect, not only in the room the joiner lands in. §10.7
                — expiry is something the server honours, so it is said as
                what the server does. */}
            <p className="fineprint muted">
              Anyone with this link can join, and once in they can read the circle&rsquo;s past
              messages. The server stops accepting the link after 7 days. People who join with
              it show as not verified until someone checks their safety number.
            </p>
          </>
        )}
        {modal.type === 'secure' && (
          <>
            <p className="muted">
              Your key exists only in this browser right now. Save an encrypted backup to the
              server so you can sign in on other devices. The server can&rsquo;t read it.
            </p>
            <button
              className="button primary wide"
              disabled={busy}
              data-testid="secure-passkey"
              onClick={() => attempt(onSecurePasskey)}
            >
              Use a passkey (recommended)
            </button>
            <div className="divider">Or use a password</div>
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
                At least 8 characters. Longer is safer, and a passkey is stronger still.
              </p>
              <button className="button" disabled={busy} data-testid="secure-password-submit">
                {busy ? 'Securing…' : 'Use this password'}
              </button>
            </form>
            {onEnrollDevice && (
              <>
                <div className="divider">Just this device</div>
                <button
                  className="button wide"
                  disabled={busy}
                  data-testid="enroll-device"
                  onClick={() => attempt(onEnrollDevice)}
                >
                  <Key size={14} /> Add one-tap sign-in on this device
                </button>
                <p className="fineprint muted">
                  Registers a passkey for this device only. Your other devices&rsquo; passkeys keep
                  working.
                </p>
              </>
            )}
            {showDevices && devices !== null && devices.length > 0 && (
              <>
                <div className="divider">Devices that can sign in</div>
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
                          Confirm revoke
                        </button>
                      ) : (
                        <button
                          className="ghost"
                          disabled={busy}
                          data-testid={`device-revoke-${d.credId}`}
                          onClick={() => setConfirmRevoke(d.credId)}
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {/* The limit stated where the button is, not in a help page.
                    "Revoke" reads as "cut that device off", and for a device
                    someone is holding, unlocked, it is not that. */}
                <p className="fineprint muted">
                  Revoking stops that passkey unlocking your account from now on. It can&rsquo;t erase
                  what is already on a device someone is holding: if one went missing while signed
                  in, assume whoever has it can read its messages.
                </p>
              </>
            )}
            <div className="divider">Or download a key file</div>
            <a
              className="button"
              href={identityKey ? URL.createObjectURL(new Blob([identityKey], { type: 'text/plain' })) : '#'}
              download="identity.e2ee-key"
              data-testid="secure-file"
              onClick={() => onSecureFile()}
            >
              <Download size={14} />
              Download key file
            </a>
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        {modal.type === 'link-send' && (
          <>
            {!linkSent ? (
              <>
                <p className="muted">
                  A device wants to sign in as <strong>you</strong>. This sends it your key,
                  encrypted so only that device can open it. Do this only if you&rsquo;re the one
                  setting up that device.
                </p>
                <p className="fineprint muted">
                  It should be showing the code{' '}
                  <strong className="mono">{modal.code}</strong>. Check that it matches before you
                  send.
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
                  {busy ? 'Sending…' : 'Send my key to it'}
                </button>
                <button className="button wide" onClick={onClose}>
                  Cancel
                </button>
                {error && <p className="error" role="alert">{error}</p>}
              </>
            ) : (
              <p className="muted" data-testid="link-sent">
                Sent. Finish signing in on the other device; it will ask you to confirm your
                handle.
              </p>
            )}
          </>
        )}
        {modal.type === 'safety' && (
          <>
            <p className="muted">
              Compare these numbers with {modal.peer} in person or on a call. If they match,
              nobody, the server included, has swapped either of your keys.
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
                it can’t change their key, and nobody can change it for them.
              </p>
            ) : modal.verified ? (
              <p className="fineprint muted">Already marked verified on this device.</p>
            ) : (
              /* Two outcomes, equally weighted (§10.4): same fill, same
                 border, same width. It was a coral fill for "they match"
                 beside a red outline for "they don't" — the asymmetry that
                 reads as "here is the button, and here is the way out of
                 pressing it". The signing ledger already does it this way. */
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
            <p className="fineprint muted">
              Verification is stored on this device only; it is your judgement, not the
              server's.
            </p>
          </>
        )}
        {modal.type === 'admin' && (
          <>
            <p className="muted">
              Everything the server knows: registered handles and groups. Circle names, rooms and
              messages stay encrypted, and no admin can read them.
            </p>
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
              <span className="overline">Groups</span>
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
                  <span>Topic</span>
                  <input
                    type="text"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="What this room is for, shown at the top"
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
                <p className="fineprint muted">
                  This room&rsquo;s messages are stored on the server, encrypted with a key everyone
                  in the circle holds. Anyone added later can read them, and they come back when you
                  sign in somewhere new. Auto-delete asks the server to remove messages older than
                  this, which limits what that key can ever unlock.
                </p>
                <button className="button primary wide" disabled={busy} data-testid="channel-save">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </form>
            )}
            <div className="chan-manage">
              <label className="field">
                {/* §11.3 — the product says "room" everywhere, so its
                    destructive dialog does too; it said "channel" here. */}
                <span>Rename {modal.voice ? 'voice room' : 'room'}</span>
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
              This is your private key. It signs your messages and signs you in.{' '}
              <strong>Anyone who has it can act as you.</strong>
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
            <p className="fineprint muted">
              Unlike the recovery file, this isn&rsquo;t protected by a code. Paste it into
              &ldquo;Use a recovery file or identity key&rdquo; when signing in on another device.
              It brings back your account and your circles.
            </p>
          </>
        )}
        {modal.type === 'circle' && (
          <>
            {modal.canManage ? (
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
                  Rename circle
                </button>
              </form>
                <fieldset className="glyph-picker">
                  {/* A real fieldset/legend, not a styled div — the four
                      buttons are one choice and a screen reader has to hear
                      the question before the options (§8.7). */}
                  <legend>Circle face</legend>
                  <p className="fineprint muted">
                    The colour is the circle&rsquo;s own and can&rsquo;t be changed: it&rsquo;s
                    how members pick it out of a list. Everyone sees the face you choose.
                  </p>
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

                {/* Governance, where the rest of the circle's settings are —
                    not in a separate "advanced" place. This number is the
                    circle's answer to the one irreversible thing it can do,
                    and it belongs beside its name and its face. */}
                <div className="divider">Letting people in</div>
                <p className="fineprint muted">
                  Anyone here can propose someone. They are added once this many members have
                  signed. One would mean no check at all, so the lowest a circle of {memberCount}{' '}
                  can set is {memberCount === 1 ? 1 : 2}.
                </p>
                <div className="threshold-picker">
                  <label className="field">
                    <span>Signatures needed</span>
                    <input
                      type="number"
                      min={memberCount === 1 ? 1 : 2}
                      max={memberCount}
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.value)}
                      data-testid="circle-threshold-input"
                    />
                  </label>
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
              </>
            ) : (
              <p className="muted">
                Only an admin can rename or delete this circle. You can leave it below.
              </p>
            )}

            <div className="divider">Leaving</div>
            <p className="fineprint muted">
              Leaving removes this circle from your account, not just this device. Your other
              devices drop it when they next connect. You&rsquo;ll need a new invite to come back;
              the others keep the circle.
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
              Leave circle
            </button>

            {modal.canManage && (
              <>
                <div className="divider">Deleting the circle</div>
                <p className="fineprint muted">
                  Deleting removes every member, re-keys their access away and removes the circle
                  from the server. This can&rsquo;t be undone.
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
                  {busy ? 'Deleting…' : 'Delete circle'}
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
                This account isn&rsquo;t secured yet. There is no passkey, password or exported key,
                so this browser holds the <strong>only</strong> copy of your key, and logging out
                now leaves nothing to sign back in with. Secure the account first and logging out
                costs you nothing.
              </p>
            ) : (
              <p className="fineprint muted">
                You&rsquo;ll need your passkey, password, or recovery or identity key to sign back
                in. Your circles and their messages come back, because they are stored encrypted on
                the server. To send again, ask to be re-added.
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
