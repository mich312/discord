import React, { useState } from 'react';
import { generateCode, wrapIdentity, unwrapIdentity } from '../lib/recovery.js';

// Identity creation + the recovery-key gate. The recovery step is not
// skippable: losing the identity key means losing the account forever
// (the relay has pinned it), so the file must leave the browser first.
export default function Onboarding({ controller }) {
  const [mode, setMode] = useState('create'); // create | restore
  const [step, setStep] = useState('name'); // name | recovery
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recovery, setRecovery] = useState(null); // {code, url, filename}
  const [downloaded, setDownloaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreCode, setRestoreCode] = useState('');

  async function createIdentity(e) {
    e.preventDefault();
    const handle = name.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(handle)) {
      setError('handle: 2–32 chars, a-z 0-9 _ . -');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = await controller.createIdentity(handle);
      const code = generateCode();
      const fileBytes = await wrapIdentity(identity, code);
      const url = URL.createObjectURL(new Blob([fileBytes], { type: 'application/octet-stream' }));
      setRecovery({ code, url, filename: `recovery-${handle}.e2ee` });
      setStep('recovery');
    } catch (e2) {
      setError(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(e) {
    e.preventDefault();
    if (!restoreFile || !restoreCode.trim()) {
      setError('recovery file and code are both required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await restoreFile.arrayBuffer());
      const identity = await unwrapIdentity(bytes, restoreCode.trim());
      await controller.restoreIdentity(identity);
      await controller.completeOnboarding();
    } catch {
      setError('could not decrypt — wrong code or corrupt file');
      setBusy(false);
    }
  }

  if (step === 'recovery') {
    return (
      <div className="centered">
        <div className="card" data-testid="recovery-step">
          <h1>save your recovery key</h1>
          <p className="muted">
            This file plus this code is the <em>only</em> way back into your account if this
            device is lost or the browser clears its storage. The server cannot reset it —
            it never sees your keys.
          </p>
          <div className="recovery-code" data-testid="recovery-code">{recovery.code}</div>
          <a
            className="button"
            href={recovery.url}
            download={recovery.filename}
            onClick={() => setDownloaded(true)}
            data-testid="download-recovery"
          >
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
            className="button primary"
            disabled={!downloaded || !confirmed || busy}
            data-testid="enter-app"
            onClick={async () => {
              setBusy(true);
              await controller.completeOnboarding();
            }}
          >
            enter
          </button>
          <p className="fineprint muted">
            What this protects: your identity key (your name on the relay). Group history
            and live message keys stay on this device only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <div className="card">
        <h1>quorum</h1>
        <p className="muted">end-to-end encrypted groups. the server stores only ciphertext.</p>
        <div className="tabs">
          <button className={mode === 'create' ? 'tab active' : 'tab'} onClick={() => setMode('create')}>
            new identity
          </button>
          <button className={mode === 'restore' ? 'tab active' : 'tab'} onClick={() => setMode('restore')}>
            restore
          </button>
        </div>
        {mode === 'create' ? (
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
            <button className="button primary" disabled={busy} data-testid="create-identity">
              {busy ? 'generating keys…' : 'create'}
            </button>
            <p className="fineprint muted">
              Your identity is a keypair generated in this browser. No email, no password —
              and no account recovery except the key file you’re about to save.
            </p>
          </form>
        ) : (
          <form onSubmit={restore}>
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
            <button className="button primary" disabled={busy} data-testid="restore-identity">
              {busy ? 'decrypting…' : 'restore identity'}
            </button>
            <p className="fineprint muted">
              Restores your identity and account name. Old group messages cannot come back —
              their keys lived only on the lost device. Ask to be re-added.
            </p>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
