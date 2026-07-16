import React, { useEffect, useState } from 'react';
import { generateCode, wrapIdentity, unwrapIdentity } from '../lib/recovery.js';
import { QuorumGlyph, Key, Download } from './icons.jsx';

// The gate: brand panel on the left states the contract, the form on the
// right performs it. Three ways in:
//  - invite fast path: link-holders pick a handle and are in the group in
//    seconds; securing the account is deferred (nagging banner inside)
//  - new identity: keypair + forced recovery-key export
//  - sign in: username + password or passkey against the relay vault;
//    advanced: paste an identity key / recovery file + code
function Gate({ children }) {
  return (
    <div className="gate">
      <div className="gate-brand">
        <div className="brand-lockup">
          <QuorumGlyph size={34} />
          <span className="wordmark">quorum</span>
        </div>
        <p className="gate-tagline">
          Rooms that keep <em>their own counsel.</em>
        </p>
        <p className="gate-sub">
          Small, invite-only circles, end-to-end encrypted with MLS. The server
          relays ciphertext it can never read — and the interface never pretends otherwise.
        </p>
        <ul className="principles">
          <li>
            <span className="p-glyph" aria-hidden="true" />
            <div>
              <strong>Sealed by default</strong>
              <span>Messages, room names, membership — all of it travels inside the encryption.</span>
            </div>
          </li>
          <li>
            <span className="p-glyph" aria-hidden="true" />
            <div>
              <strong>Your identity is a key, not an email</strong>
              <span>A keypair born in this browser. Recovery is a file you hold, not a reset button we own.</span>
            </div>
          </li>
          <li>
            <span className="p-glyph" aria-hidden="true" />
            <div>
              <strong>The roster is the boundary</strong>
              <span>Joiners see nothing from before they joined. That is the cost of it being true.</span>
            </div>
          </li>
        </ul>
      </div>
      <div className="gate-form">{children}</div>
    </div>
  );
}

export default function Onboarding({ controller }) {
  const invited = !!controller.pendingInvite;
  const [mode, setMode] = useState('create'); // create | signin
  const [step, setStep] = useState('name'); // name | recovery
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyText, setBusyText] = useState(null);
  // A relay handshake refusal (e.g. invite-only registration) lands the
  // user back here with the reason attached to the controller.
  const [error, setError] = useState(controller.authError ?? null);
  // Whether fresh identities need an invite link on this relay. UI hint
  // only — the relay enforces it during the handshake either way.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [recovery, setRecovery] = useState(null); // {code, url, filename}
  const [downloaded, setDownloaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreCode, setRestoreCode] = useState('');
  const [pastedKey, setPastedKey] = useState('');

  const validHandle = (h) => /^[a-z0-9_.-]{2,32}$/.test(h);

  useEffect(() => {
    controller.authError = null;
    if (!invited) {
      controller.registerPolicy().then((p) => setInviteRequired(!!p.invite_required));
    }
  }, []);

  async function run(label, fn) {
    setBusy(true);
    setBusyText(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setBusyText(null);
    }
  }

  async function joinFast(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('handle: 2–32 chars, a-z 0-9 _ . -');
    await run('creating keys…', async () => {
      await controller.createIdentity(handle);
      // Deferred securing: the banner inside nags until a vault exists.
      await controller.completeOnboarding(false);
    });
  }

  async function createIdentity(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('handle: 2–32 chars, a-z 0-9 _ . -');
    await run('generating keys…', async () => {
      const identity = await controller.createIdentity(handle);
      const code = generateCode();
      const fileBytes = await wrapIdentity(identity, code);
      const url = URL.createObjectURL(new Blob([fileBytes], { type: 'application/octet-stream' }));
      setRecovery({ code, url, filename: `recovery-${handle}.e2ee` });
      setStep('recovery');
      setBusy(false);
      setBusyText(null);
    });
  }

  async function signIn(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('enter your handle first');
    if (pastedKey.trim()) {
      return run('restoring…', async () => {
        const identity = Uint8Array.from(atob(pastedKey.trim()), (c) => c.charCodeAt(0));
        await controller.restoreIdentity(identity);
        await controller.completeOnboarding(true);
      });
    }
    if (restoreFile && restoreCode.trim()) {
      return run('decrypting…', async () => {
        const bytes = new Uint8Array(await restoreFile.arrayBuffer());
        const identity = await unwrapIdentity(bytes, restoreCode.trim()).catch(() => {
          throw new Error('could not decrypt — wrong code or corrupt file');
        });
        await controller.restoreIdentity(identity);
        await controller.completeOnboarding(true);
      });
    }
    if (!password) return setError('enter your password (or use the passkey button)');
    await run('deriving keys… (a second or two)', () =>
      controller.signInWithPassword(handle, password)
    );
  }

  async function signInPasskey() {
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('enter your handle first');
    await run('waiting for your passkey…', () => controller.signInWithPasskey(handle));
  }

  if (step === 'recovery') {
    return (
      <Gate>
        <div className="card" data-testid="recovery-step">
          <h1>Save your recovery key</h1>
          <p className="muted lede">
            This file plus this code gets your account back if this device is lost. The
            server cannot reset it — it never sees your keys. (You can also add a passkey
            or password later, from inside.)
          </p>
          <div className="recovery-code" data-testid="recovery-code">{recovery.code}</div>
          <a
            className="button wide"
            href={recovery.url}
            download={recovery.filename}
            onClick={() => setDownloaded(true)}
            data-testid="download-recovery"
          >
            <Download />
            download {recovery.filename}
          </a>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="confirm-saved"
            />
            I stored the file and the code somewhere that isn’t this device
          </label>
          <button
            className="button primary wide"
            disabled={!downloaded || !confirmed || busy}
            data-testid="enter-app"
            onClick={() => run('entering…', () => controller.completeOnboarding(true))}
          >
            enter
          </button>
        </div>
      </Gate>
    );
  }

  if (invited) {
    return (
      <Gate>
        <div className="card">
          <h1>You’ve been invited</h1>
          <p className="muted lede">
            Pick a handle and you’re in — encrypted end-to-end from the first message.
            You can secure the account right after.
          </p>
          <form onSubmit={joinFast}>
            <label className="field">
              <span>handle</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. sam"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="join-fast">
              {busyText ?? 'join'}
            </button>
          </form>
          <p className="fineprint muted">
            Already have an account here?{' '}
            <button className="linkish" onClick={() => (location.href = location.pathname)}>
              sign in first, then use the link again
            </button>
          </p>
          {error && <p className="error">{error}</p>}
        </div>
      </Gate>
    );
  }

  return (
    <Gate>
      <div className="card">
        <h1>Enter quorum</h1>
        <p className="muted lede">Your identity is a keypair. Everything else follows from that.</p>
        <div className="tabs">
          <button className={mode === 'create' ? 'tab active' : 'tab'} onClick={() => setMode('create')}>
            new identity
          </button>
          <button className={mode === 'signin' ? 'tab active' : 'tab'} data-testid="tab-signin" onClick={() => setMode('signin')}>
            sign in
          </button>
        </div>
        {mode === 'create' ? (
          inviteRequired ? (
            <div data-testid="invite-required">
              <p className="muted lede">
                This relay is <strong>invite-only</strong>. Accounts are created by opening
                an invite link — ask a member of the circle you want to join to send you one.
              </p>
              <p className="fineprint muted">
                Already have an account here? Use the sign in tab.
              </p>
            </div>
          ) : (
          <form onSubmit={createIdentity}>
            <label className="field">
              <span>handle</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. alice"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="create-identity">
              {busyText ?? 'create identity'}
            </button>
            <p className="fineprint muted">
              Your identity is a keypair generated in this browser. No email — recovery is
              the key file you’re about to save, plus any passkey/password you add later.
            </p>
          </form>
          )
        ) : (
          <form onSubmit={signIn}>
            <label className="field">
              <span>handle</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="your handle"
                data-testid="signin-handle"
              />
            </label>
            <label className="field">
              <span>password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="signin-password"
              />
            </label>
            <div className="row">
              <button className="button primary" disabled={busy} data-testid="signin-submit">
                {busyText ?? 'sign in'}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                data-testid="signin-passkey"
                onClick={signInPasskey}
              >
                <Key size={14} />
                use passkey
              </button>
            </div>
            <details className="advanced">
              <summary className="muted">advanced: identity key or recovery file</summary>
              <label className="field">
                <span>identity key (paste)</span>
                <textarea
                  className="keybox small"
                  value={pastedKey}
                  onChange={(e) => setPastedKey(e.target.value)}
                  data-testid="paste-key"
                />
              </label>
              <label className="field">
                <span>recovery file</span>
                <input type="file" onChange={(e) => setRestoreFile(e.target.files[0] ?? null)} data-testid="restore-file" />
              </label>
              <label className="field">
                <span>recovery code</span>
                <input
                  value={restoreCode}
                  onChange={(e) => setRestoreCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  data-testid="restore-code"
                />
              </label>
            </details>
            <p className="fineprint muted">
              Signing in restores your identity, not old messages — their keys lived only
              on the previous device. Ask to be re-added to circles.
            </p>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </Gate>
  );
}
