import React, { useEffect, useRef, useState } from 'react';
import { generateCode, wrapIdentity, unwrapIdentity } from '../lib/recovery.js';
import { QuorumGlyph, Key, Download } from './icons.jsx';

// The gate: brand panel on the left states the contract, the form on the
// right performs it. Three ways in:
//  - invite fast path: link-holders pick a handle and are in the group in
//    seconds; securing the account is deferred (nagging banner inside)
//  - new identity: keypair + forced recovery-key export
//  - sign in: handle-first. We probe the relay for how THIS account was
//    secured, then offer only the one method that can work (passkey or
//    password) — never the whole menu. A recovery file / pasted identity
//    key stays available as a device-portable fallback that needs no vault.
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
          Small, invite-only circles, end-to-end encrypted. The server passes along
          messages it can&rsquo;t read — and the interface never pretends otherwise.
        </p>
        <ul className="principles">
          <li>
            <span className="p-glyph">01</span>
            <div>
              <strong>Sealed by default</strong>
              <span>Messages, room names, membership — all of it travels inside the encryption.</span>
            </div>
          </li>
          <li>
            <span className="p-glyph">02</span>
            <div>
              <strong>Your identity is a key, not an email</strong>
              <span>A keypair born in this browser. Recovery is a file you hold, not a reset button we own.</span>
            </div>
          </li>
          <li>
            <span className="p-glyph">03</span>
            <div>
              <strong>The roster is the boundary</strong>
              <span>New members see nothing from before they joined.</span>
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
  // Sign-in is handle-first: undefined = not looked up yet; then the probed
  // vault kind ('passkey' | 'password') or 'none' when no vault exists.
  const [signinKind, setSigninKind] = useState(undefined);
  // Pending passkey-autofill (conditional UI) request, so we can cancel it.
  const conditionalAbort = useRef(null);

  const validHandle = (h) => /^[a-z0-9_.-]{2,32}$/.test(h);

  useEffect(() => {
    controller.authError = null;
    if (!invited) {
      controller.registerPolicy().then((p) => setInviteRequired(!!p.invite_required));
    }
  }, []);

  // Passkey autofill: while the handle field is showing, arm a conditional
  // discoverable request so resident passkeys surface in the browser's
  // autocomplete dropdown. It resolves only if the user picks one (→ signed
  // in); otherwise it stays pending until we abort it. No-op where unsupported.
  const armAutofill = !invited && mode === 'signin' && signinKind === undefined;
  useEffect(() => {
    if (!armAutofill) return;
    let done = false;
    const ac = new AbortController();
    conditionalAbort.current = ac;
    (async () => {
      try {
        if (!(await window.PublicKeyCredential?.isConditionalMediationAvailable?.())) return;
        if (ac.signal.aborted) return;
        await controller.signInWithDiscoverablePasskey({ mediation: 'conditional', signal: ac.signal });
        done = true;
      } catch (e) {
        // Abort (navigated away / chose another method) is the common case.
        if (e.name !== 'AbortError' && !ac.signal.aborted) setError(e.message);
      }
    })();
    return () => {
      // Leave a successful ceremony alone; only cancel one still waiting.
      if (!done) ac.abort();
      if (conditionalAbort.current === ac) conditionalAbort.current = null;
    };
  }, [armAutofill]);

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

  // Step one of sign-in: look the handle up so we can show the one method
  // this account actually uses, instead of a menu of mostly-wrong options.
  async function lookUpAccount(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('enter your handle first');
    await run('looking up your account…', async () => {
      const kind = await controller.accountKind(handle);
      setSigninKind(kind ?? 'none');
      setBusy(false);
      setBusyText(null);
    });
  }

  function changeHandle() {
    setSigninKind(undefined);
    setPassword('');
    setError(null);
  }

  async function signInPassword(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!password) return setError('enter your password');
    await run('deriving keys… (a second or two)', () =>
      controller.signInWithPassword(handle, password)
    );
  }

  async function signInPasskey() {
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('enter your handle first');
    await run('waiting for your passkey…', () => controller.signInWithPasskey(handle));
  }

  // No handle at all: let the authenticator offer its resident passkeys.
  async function signInDiscoverablePasskey() {
    // A modal get() can't run while a conditional one is pending — cancel it.
    conditionalAbort.current?.abort();
    conditionalAbort.current = null;
    await run('waiting for your passkey…', () => controller.signInWithDiscoverablePasskey());
  }

  // Fallback path: restore a device-portable identity (recovery file + code,
  // or a pasted identity key). Needs no server vault, so it works regardless
  // of how — or whether — the account was secured for cross-device sign-in.
  async function restoreIdentity(e) {
    e.preventDefault();
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
    setError('add a recovery file + code, or paste an identity key');
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
          <button
            className={mode === 'create' ? 'tab active' : 'tab'}
            onClick={() => { setMode('create'); setError(null); }}
          >
            new identity
          </button>
          <button
            className={mode === 'signin' ? 'tab active' : 'tab'}
            data-testid="tab-signin"
            onClick={() => { setMode('signin'); setSigninKind(undefined); setError(null); }}
          >
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
          <div className="signin">
            {signinKind === undefined ? (
              <form onSubmit={lookUpAccount}>
                <label className="field">
                  <span>handle</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="your handle"
                    autoComplete="username webauthn"
                    data-testid="signin-handle"
                  />
                </label>
                <button className="button primary wide" disabled={busy} data-testid="signin-continue">
                  {busyText ?? 'continue'}
                </button>
                <div className="divider">or</div>
                <button
                  type="button"
                  className="button wide"
                  disabled={busy}
                  data-testid="signin-passkey-discoverable"
                  onClick={signInDiscoverablePasskey}
                >
                  <Key size={14} />
                  sign in with a passkey
                </button>
                <p className="fineprint muted">
                  No handle needed — your device offers the passkeys it holds for quorum.
                </p>
              </form>
            ) : (
              <>
                <p className="signin-as muted">
                  signing in as <strong>{name.trim().toLowerCase()}</strong>
                  <button type="button" className="linkish" onClick={changeHandle} data-testid="signin-change">
                    change
                  </button>
                </p>
                {signinKind === 'passkey' && (
                  <>
                    <p className="muted lede">This account signs in with a passkey.</p>
                    <button
                      type="button"
                      className="button primary wide"
                      disabled={busy}
                      data-testid="signin-passkey"
                      onClick={signInPasskey}
                    >
                      <Key size={14} />
                      {busyText ?? 'sign in with passkey'}
                    </button>
                  </>
                )}
                {signinKind === 'password' && (
                  <form onSubmit={signInPassword}>
                    <p className="muted lede">This account signs in with a password.</p>
                    <label className="field">
                      <span>password</span>
                      <input
                        autoFocus
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        data-testid="signin-password"
                      />
                    </label>
                    <button className="button primary wide" disabled={busy} data-testid="signin-submit">
                      {busyText ?? 'sign in'}
                    </button>
                  </form>
                )}
                {signinKind === 'none' && (
                  <p className="muted lede" data-testid="signin-none">
                    No cross-device sign-in is set up for{' '}
                    <strong>{name.trim().toLowerCase()}</strong>. If you saved a recovery
                    file or identity key when you created this account, restore it below.
                  </p>
                )}
              </>
            )}

            <details className="advanced" open={signinKind === 'none' || undefined}>
              <summary className="muted">recovery file or identity key</summary>
              <form onSubmit={restoreIdentity}>
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
                <label className="field">
                  <span>…or paste an identity key</span>
                  <textarea
                    className="keybox small"
                    value={pastedKey}
                    onChange={(e) => setPastedKey(e.target.value)}
                    data-testid="paste-key"
                  />
                </label>
                <button className="button wide" disabled={busy} data-testid="restore-submit">
                  {busyText ?? 'restore identity'}
                </button>
              </form>
            </details>
            <p className="fineprint muted">
              Signing in restores your identity, not old messages — their keys lived only
              on the previous device. Ask to be re-added to circles.
            </p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </Gate>
  );
}
