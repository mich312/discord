import React, { useState } from 'react';

export default function Modal({ modal, onClose }) {
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
