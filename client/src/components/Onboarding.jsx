import React, { useEffect, useRef, useState } from 'react';
import { generateCode, wrapIdentity, unwrapIdentity } from '../lib/recovery.js';
import { createLinkOffer, openSealed } from '../lib/link.js';
import { QuorumGlyph, Key, Download, LinkGlyph, Copy, Check, Lock, Archive } from './icons.jsx';
import Qr from './Qr.jsx';
import { cx } from '../lib/cx.js';
import { errorText } from '../lib/fail-text.js';

// The gate: brand panel on the left states the contract, the form on the
// right performs it. Three ways in:
//  - invite fast path: link-holders pick a handle and are in the group in
//    seconds; securing the account is deferred (nagging banner inside)
//  - new identity: keypair + forced recovery-key export
//  - sign in: handle-first. We probe the relay for how THIS account was
//    secured, then offer only the one method that can work (passkey or
//    password) — never the whole menu. A recovery file / pasted identity
//    key stays available as a device-portable fallback that needs no vault.
// On a touch screen a focused field opens the keyboard over the facts the
// person is deciding on, so the handle field waits to be tapped there.
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function Gate({ invite = false, children }) {
  return (
    // `gate-invite`: on phones the invite form comes before the facts.
    <div className={cx('gate', invite && 'gate-invite')}>
      <div className="gate-brand">
        <div className="brand-lockup">
          <QuorumGlyph size={34} />
          <span className="wordmark">quorum</span>
        </div>
        {/* What the product is, before the form asks for anything. These
            facts are read before deciding, so each has to stay true. */}
        <p className="gate-tagline">Encrypted group chat for small circles.</p>
        <ul className="principles">
          <li>
            <span className="p-glyph">
              <Lock size={18} />
            </span>
            <strong>Encrypted on your device</strong>
          </li>
          <li>
            <span className="p-glyph">
              <Key size={18} />
            </span>
            <strong>No email or phone number</strong>
          </li>
          <li>
            <span className="p-glyph">
              <Archive size={18} />
            </span>
            <strong>New members can read past messages</strong>
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
  // Device-linking (step === 'link'): the offer we're showing as a QR, and the
  // handle we received once the other device sends its identity.
  const [linkOffer, setLinkOffer] = useState(null);
  const [linkHandle, setLinkHandle] = useState(null);
  const [copied, setCopied] = useState(false);

  const HANDLE_RULE = 'Handles are 2–32 characters: a–z, 0–9, and _ . -';
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
        if (ac.signal.aborted) return; // navigated away / chose another method
        if (e.linkFallback) return startLink();
        // Nothing was asked of the user here (autofill arms on its own), so
        // a failure stays quiet; the buttons below still work.
      }
    })();
    return () => {
      // Leave a successful ceremony alone; only cancel one still waiting.
      if (!done) ac.abort();
      if (conditionalAbort.current === ac) conditionalAbort.current = null;
    };
  }, [armAutofill]);

  // Device-linking receiver: while the QR is up, mint an offer and poll the
  // rendezvous. When the other device sends the sealed identity, adopt it and
  // ask the user to confirm the handle before entering.
  useEffect(() => {
    if (step !== 'link') return;
    let cancelled = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        const offer = await createLinkOffer(window.location.origin);
        if (cancelled) return;
        setLinkOffer(offer);
        while (!cancelled) {
          const payload = await controller.linkPoll(offer.blobId).catch(() => null);
          if (cancelled) return;
          if (payload) {
            try {
              const identity = await openSealed(offer.privateKey, payload);
              await controller.restoreIdentity(identity);
              if (cancelled) return;
              setLinkHandle(controller.me);
              return; // stop polling; wait for the user's confirm
            } catch {
              // A stale or foreign blob at this id — keep waiting for ours.
            }
          }
          await sleep(2000);
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e, 'Couldn’t start linking. Try again.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  async function run(label, fn, fallback) {
    setBusy(true);
    setBusyText(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, fallback));
      setBusy(false);
      setBusyText(null);
    }
  }

  async function joinFast(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError(HANDLE_RULE);
    await run('Creating…', async () => {
      await controller.createIdentity(handle);
      // Deferred securing: the banner inside nags until a vault exists.
      await controller.completeOnboarding(false);
    });
  }

  async function createIdentity(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError(HANDLE_RULE);
    await run('Creating…', async () => {
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
    if (!validHandle(handle)) return setError('Enter your handle first.');
    await run('Checking…', async () => {
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
    if (!password) return setError('Enter your password.');
    await run(
      'Unlocking…',
      () => controller.signInWithPassword(handle, password),
      'Couldn’t sign in. Check the handle and password.'
    );
  }

  async function signInPasskey() {
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('Enter your handle first.');
    await run('Waiting for passkey…', () => controller.signInWithPasskey(handle));
  }

  // No handle at all: let the authenticator offer its resident passkeys.
  async function signInDiscoverablePasskey() {
    // A modal get() can't run while a conditional one is pending — cancel it.
    conditionalAbort.current?.abort();
    conditionalAbort.current = null;
    setBusy(true);
    setBusyText('Waiting for passkey…');
    setError(null);
    try {
      await controller.signInWithDiscoverablePasskey();
    } catch (e) {
      setBusy(false);
      setBusyText(null);
      // The passkey identified you but this device can't unlock the vault —
      // slide into linking from a device you're already on instead of erroring.
      if (e.linkFallback) return startLink();
      setError(errorText(e));
    }
  }

  function startLink() {
    conditionalAbort.current?.abort();
    conditionalAbort.current = null;
    setBusy(false);
    setBusyText(null);
    setError(null);
    setLinkOffer(null);
    setLinkHandle(null);
    setStep('link');
  }

  async function confirmLink() {
    await run('Signing in…', () => controller.completeOnboarding(true));
  }

  async function rejectLink() {
    await controller.logout();
    setLinkHandle(null);
    setSigninKind(undefined);
    setStep('name');
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // Fallback path: restore a device-portable identity (recovery file + code,
  // or a pasted identity key). Needs no server vault, so it works regardless
  // of how — or whether — the account was secured for cross-device sign-in.
  async function restoreIdentity(e) {
    e.preventDefault();
    if (pastedKey.trim()) {
      return run('Restoring…', async () => {
        const identity = Uint8Array.from(atob(pastedKey.trim()), (c) => c.charCodeAt(0));
        await controller.restoreIdentity(identity);
        await controller.completeOnboarding(true);
      });
    }
    if (restoreFile && restoreCode.trim()) {
      return run('Restoring…', async () => {
        const bytes = new Uint8Array(await restoreFile.arrayBuffer());
        const identity = await unwrapIdentity(bytes, restoreCode.trim()).catch(() => {
          throw new Error('That code doesn’t open this file. Check the code.');
        });
        await controller.restoreIdentity(identity);
        await controller.completeOnboarding(true);
      });
    }
    setError('Add a recovery file and its code, or paste an identity key.');
  }

  if (step === 'link') {
    return (
      <Gate>
        <div className="card" data-testid="link-step">
          {!linkHandle ? (
            <>
              <h1>Sign in from another device</h1>
              <p className="muted lede">Scan this with a device that&rsquo;s already signed in.</p>
              {linkOffer ? (
                <>
                  <div className="qr-card">
                    <Qr url={linkOffer.url} />
                  </div>
                  <p className="link-code">
                    The other device should show <strong data-testid="link-code">{linkOffer.code}</strong>
                  </p>
                  <button className="button wide" onClick={() => copy(linkOffer.url)} data-testid="copy-link">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <p className="fineprint muted waiting" data-testid="link-waiting">
                    Waiting for the other device&hellip;
                  </p>
                </>
              ) : (
                <p className="fineprint muted">Preparing&hellip;</p>
              )}
              <p className="fineprint muted">
                <button type="button" className="linkish" onClick={() => setStep('name')}>
                  Back
                </button>
              </p>
            </>
          ) : (
            <>
              <h1>
                Sign in as <span className="link-handle">{linkHandle}</span>?
              </h1>
              <button
                className="button primary wide"
                onClick={confirmLink}
                disabled={busy}
                data-testid="link-confirm"
              >
                {busyText ?? 'Sign in'}
              </button>
              <button className="button wide" onClick={rejectLink} disabled={busy} data-testid="link-reject">
                Not me
              </button>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </Gate>
    );
  }

  if (step === 'recovery') {
    return (
      <Gate>
        <div className="card" data-testid="recovery-step">
          <h1>Save your recovery file and code</h1>
          <p className="muted lede">
            The file and code restore your account. Nobody can reset it.
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
            Download file
          </a>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="confirm-saved"
            />
            <span>I saved both somewhere other than this device</span>
          </label>
          <button
            className="button primary wide"
            disabled={!downloaded || !confirmed || busy}
            data-testid="enter-app"
            onClick={() => run('Opening…', () => controller.completeOnboarding(true))}
          >
            Continue
          </button>
        </div>
      </Gate>
    );
  }

  if (invited) {
    return (
      <Gate invite>
        <div className="card">
          <h1>You’ve been invited</h1>
          {/* The history fact, before the decision, on every screen size. */}
          <p className="muted lede">You&rsquo;ll be able to read past messages.</p>
          <form onSubmit={joinFast}>
            <label className="field">
              <span>Handle</span>
              <input
                autoFocus={!COARSE}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. sam"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="join-fast">
              {busyText ?? 'Join'}
            </button>
            <p className="fineprint muted">You can&rsquo;t change your handle later.</p>
          </form>
          <p className="fineprint muted">
            Have an account?{' '}
            <button className="linkish" onClick={() => (location.href = location.pathname)}>
              Sign in, then reopen the link
            </button>
          </p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </Gate>
    );
  }

  return (
    <Gate>
      <div className="card">
        {/* The tabs name the screen; the heading is for assistive tech. */}
        <h1 className="sr-only">{mode === 'create' ? 'Create your account' : 'Sign in'}</h1>
        <div className="tabs">
          <button
            className={cx('tab', mode === 'create' && 'active')}
            onClick={() => { setMode('create'); setError(null); }}
          >
            New account
          </button>
          <button
            className={cx('tab', mode === 'signin' && 'active')}
            data-testid="tab-signin"
            onClick={() => { setMode('signin'); setSigninKind(undefined); setError(null); }}
          >
            Sign in
          </button>
        </div>
        {mode === 'create' ? (
          inviteRequired ? (
            <div data-testid="invite-required">
              <p className="muted lede">You need an invite link. Ask a member for one.</p>
            </div>
          ) : (
          <form onSubmit={createIdentity}>
            <label className="field">
              <span>Handle</span>
              <input
                autoFocus={!COARSE}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. alice"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="create-identity">
              {busyText ?? 'Create account'}
            </button>
            <p className="fineprint muted">You can&rsquo;t change your handle later.</p>
          </form>
          )
        ) : (
          <div className="signin">
            {signinKind === undefined ? (
              <form onSubmit={lookUpAccount}>
                <label className="field">
                  <span>Handle</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="username webauthn"
                    data-testid="signin-handle"
                  />
                </label>
                <button className="button primary wide" disabled={busy} data-testid="signin-continue">
                  {busyText ?? 'Continue'}
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
                  Use passkey
                </button>
                {/* The other ways in look alike: outlined, full width. */}
                <button
                  type="button"
                  className="button wide device-link-entry"
                  disabled={busy}
                  onClick={startLink}
                  data-testid="signin-link"
                >
                  <LinkGlyph size={14} /> Use another device
                </button>
              </form>
            ) : (
              <>
                <p className="signin-as muted">
                  Signing in as <strong>{name.trim().toLowerCase()}</strong>
                  <button type="button" className="linkish" onClick={changeHandle} data-testid="signin-change">
                    Change
                  </button>
                </p>
                {signinKind === 'passkey' && (
                  <>
                    <button
                      type="button"
                      className="button primary wide"
                      disabled={busy}
                      data-testid="signin-passkey"
                      onClick={signInPasskey}
                    >
                      <Key size={14} />
                      {busyText ?? 'Use passkey'}
                    </button>
                  </>
                )}
                {signinKind === 'password' && (
                  <form onSubmit={signInPassword}>
                    <label className="field">
                      <span>Password</span>
                      <input
                        autoFocus
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        data-testid="signin-password"
                      />
                    </label>
                    <button className="button primary wide" disabled={busy} data-testid="signin-submit">
                      {busyText ?? 'Sign in'}
                    </button>
                  </form>
                )}
                {signinKind === 'none' && (
                  <p className="muted lede" data-testid="signin-none">
                    No passkey or password is set up. Use a recovery file or key below.
                  </p>
                )}
              </>
            )}

            <details className="advanced" open={signinKind === 'none' || undefined}>
              <summary className="muted">Recovery file or key</summary>
              <form onSubmit={restoreIdentity}>
                <label className="field">
                  <span>Recovery file</span>
                  <input type="file" onChange={(e) => setRestoreFile(e.target.files[0] ?? null)} data-testid="restore-file" />
                </label>
                <label className="field">
                  <span>Recovery code</span>
                  <input
                    value={restoreCode}
                    onChange={(e) => setRestoreCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    data-testid="restore-code"
                  />
                </label>
                <label className="field">
                  <span>Or paste an identity key</span>
                  <textarea
                    className="keybox small"
                    value={pastedKey}
                    onChange={(e) => setPastedKey(e.target.value)}
                    data-testid="paste-key"
                  />
                </label>
                <button className="button wide" disabled={busy} data-testid="restore-submit">
                  {busyText ?? 'Restore'}
                </button>
              </form>
            </details>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </Gate>
  );
}
