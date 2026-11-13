import React, { useEffect, useRef, useState } from 'react';
import { generateCode, wrapIdentity, unwrapIdentity } from '../lib/recovery.js';
import { createLinkOffer, openSealed } from '../lib/link.js';
import { QuorumGlyph, Key, Download, LinkGlyph, Copy, Check, Lock, Archive } from './icons.jsx';
import Qr from './Qr.jsx';
import { cx } from '../lib/cx.js';

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
        {/* Says what the product is before the form asks for anything
            (§11.1), in one colour. The third point used to read "New members
            see nothing from before they joined", which stopped being true
            when history moved to the relay: a joiner reads it back, and the
            room header says so. The onboarding claim is the one a person
            reads before deciding, so it is the one that has to be right. */}
        <p className="gate-tagline">Encrypted group chat for small circles.</p>
        <p className="gate-sub">
          Small, invite-only groups. The server stores your messages but can&rsquo;t read them.
        </p>
        <ul className="principles">
          <li>
            <span className="p-glyph">
              <Lock size={18} />
            </span>
            <div>
              <strong>Encrypted on your device</strong>
              <span>Messages, room names and member lists are encrypted before they leave it.</span>
            </div>
          </li>
          <li>
            <span className="p-glyph">
              <Key size={18} />
            </span>
            <div>
              <strong>No email, no phone number</strong>
              <span>
                Your account is a key made in this browser. There&rsquo;s no reset link, so you
                back it up with a passkey, a password or a key file.
              </span>
            </div>
          </li>
          <li>
            <span className="p-glyph">
              <Archive size={18} />
            </span>
            <div>
              <strong>People who join later can read back</strong>
              <span>
                A room&rsquo;s history is open to everyone in the circle, including new members. A
                room can ask the server to delete old messages on a schedule.
              </span>
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
        if (e.name !== 'AbortError') setError(e.message);
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
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

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
    if (!validHandle(handle)) return setError(HANDLE_RULE);
    await run('Creating your key…', async () => {
      await controller.createIdentity(handle);
      // Deferred securing: the banner inside nags until a vault exists.
      await controller.completeOnboarding(false);
    });
  }

  async function createIdentity(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError(HANDLE_RULE);
    await run('Creating your key…', async () => {
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
    await run('Looking up your account…', async () => {
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
    await run('Unlocking… (a second or two)', () =>
      controller.signInWithPassword(handle, password)
    );
  }

  async function signInPasskey() {
    const handle = name.trim().toLowerCase();
    if (!validHandle(handle)) return setError('Enter your handle first.');
    await run('Waiting for your passkey…', () => controller.signInWithPasskey(handle));
  }

  // No handle at all: let the authenticator offer its resident passkeys.
  async function signInDiscoverablePasskey() {
    // A modal get() can't run while a conditional one is pending — cancel it.
    conditionalAbort.current?.abort();
    conditionalAbort.current = null;
    setBusy(true);
    setBusyText('Waiting for your passkey…');
    setError(null);
    try {
      await controller.signInWithDiscoverablePasskey();
    } catch (e) {
      setBusy(false);
      setBusyText(null);
      // The passkey identified you but this device can't unlock the vault —
      // slide into linking from a device you're already on instead of erroring.
      if (e.linkFallback) return startLink();
      setError(e.message);
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
      return run('Decrypting…', async () => {
        const bytes = new Uint8Array(await restoreFile.arrayBuffer());
        const identity = await unwrapIdentity(bytes, restoreCode.trim()).catch(() => {
          throw new Error('That code doesn’t open this file. Check the code, or try another copy of the file.');
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
              <p className="muted lede">
                On a device where you&rsquo;re already signed in, scan this code or paste the
                link. Your key moves across encrypted, and the server only passes it along.
              </p>
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
                    {copied ? 'Link copied' : 'Copy link instead'}
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
                  Back to sign in
                </button>
              </p>
            </>
          ) : (
            <>
              <h1>
                Sign in as <span className="link-handle">{linkHandle}</span>?
              </h1>
              <p className="muted lede">
                A device just handed over this identity. If that handle is yours, you&rsquo;re in.
                If it isn&rsquo;t, don&rsquo;t continue.
              </p>
              <button
                className="button primary wide"
                onClick={confirmLink}
                disabled={busy}
                data-testid="link-confirm"
              >
                {busyText ?? 'Yes, that’s me'}
              </button>
              <button className="button wide" onClick={rejectLink} disabled={busy} data-testid="link-reject">
                No, that isn&rsquo;t me
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
          <h1>Save your recovery key</h1>
          <p className="muted lede">
            This file and this code get your account back on any device. The server never
            sees your key, so it can&rsquo;t reset it. You can add a passkey or password later.
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
            Download {recovery.filename}
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
            onClick={() => run('Opening quorum…', () => controller.completeOnboarding(true))}
          >
            Continue
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
            Pick a handle to join. You can back up your account right after.
          </p>
          <form onSubmit={joinFast}>
            <label className="field">
              <span>Handle</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. sam"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="join-fast">
              {busyText ?? 'Join'}
            </button>
          </form>
          <p className="fineprint muted">
            Already have an account here?{' '}
            <button className="linkish" onClick={() => (location.href = location.pathname)}>
              Sign in first, then open the link again
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
        <h1>{mode === 'create' ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted lede">
          {mode === 'create'
            ? 'Pick a handle. You’ll back up your key next.'
            : 'Use your handle, then the passkey or password you set up.'}
        </p>
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
              <p className="muted lede">
                This server is <strong>invite-only</strong>. Accounts are created by opening an
                invite link, so ask a member of the circle you want to join to send you one.
              </p>
              <p className="fineprint muted">
                Already have an account here? Use the Sign in tab.
              </p>
            </div>
          ) : (
          <form onSubmit={createIdentity}>
            <label className="field">
              <span>Handle</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. alice"
                data-testid="handle-input"
              />
            </label>
            <button className="button primary wide" disabled={busy} data-testid="create-identity">
              {busyText ?? 'Create account'}
            </button>
            <p className="fineprint muted">Members of your circles see this name.</p>
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
                    placeholder="your handle"
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
                  Sign in with a passkey
                </button>
                <p className="fineprint muted">
                  No handle needed. Your device offers the passkeys it has for quorum.
                </p>
                <button
                  type="button"
                  className="linkish device-link-entry"
                  onClick={startLink}
                  data-testid="signin-link"
                >
                  <LinkGlyph size={14} /> Sign in from another device
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
                    <p className="muted lede">This account signs in with a passkey.</p>
                    <button
                      type="button"
                      className="button primary wide"
                      disabled={busy}
                      data-testid="signin-passkey"
                      onClick={signInPasskey}
                    >
                      <Key size={14} />
                      {busyText ?? 'Sign in with passkey'}
                    </button>
                  </>
                )}
                {signinKind === 'password' && (
                  <form onSubmit={signInPassword}>
                    <p className="muted lede">This account signs in with a password.</p>
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
                    No cross-device sign-in is set up for{' '}
                    <strong>{name.trim().toLowerCase()}</strong>. If you saved a recovery
                    file or identity key when you created this account, restore it below.
                  </p>
                )}
              </>
            )}

            <details className="advanced" open={signinKind === 'none' || undefined}>
              <summary className="muted">Use a recovery file or identity key</summary>
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
                  {busyText ?? 'Restore account'}
                </button>
              </form>
            </details>
            <p className="fineprint muted">
              Signing in brings back your circles and their history. To send in a circle
              again, ask a member to re-add you or open a fresh invite link.
            </p>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </Gate>
  );
}
