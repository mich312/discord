// WebAuthn plumbing: convert between webauthn-rs JSON (base64url strings)
// and the browser API (ArrayBuffers), and run the PRF extension that
// turns a passkey into a deterministic wrap key for the identity vault.

const b64u = {
  enc: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, ''),
  dec: (s) =>
    Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
};

/** webauthn-rs CreationChallengeResponse JSON -> credentials.create options.
    When `prfSalt` is given, PRF is EVALUATED during creation itself: iOS
    grants exactly one authenticator ceremony per user gesture, so the
    old create-then-assert dance (a second Face ID prompt milliseconds
    after the first) died with NotAllowedError on iPhones. Evaluating in
    the same ceremony sidesteps that; authenticators that only evaluate
    PRF on get() simply return no result here and the caller falls back. */
export function parseCreationOptions(json, prfSalt) {
  const pk = json.publicKey;
  const options = {
    ...pk,
    challenge: b64u.dec(pk.challenge),
    user: { ...pk.user, id: b64u.dec(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({ ...c, id: b64u.dec(c.id) })),
  };
  options.extensions = {
    ...(options.extensions ?? {}),
    prf: prfSalt ? { eval: { first: prfSalt } } : {},
  };
  return options;
}

/** create() result -> webauthn-rs RegisterPublicKeyCredential JSON */
export function serializeRegistration(credential) {
  // Transports tell the server how this credential can be reached, so a
  // later sign-in's allowCredentials routes iOS straight to iCloud
  // Keychain ("internal"/"hybrid") instead of asking for a security key.
  const known = ['usb', 'nfc', 'ble', 'internal', 'hybrid'];
  const transports = (credential.response.getTransports?.() ?? []).filter((t) =>
    known.includes(t)
  );
  return {
    id: credential.id,
    rawId: b64u.enc(credential.rawId),
    type: credential.type,
    extensions: {},
    response: {
      attestationObject: b64u.enc(credential.response.attestationObject),
      clientDataJSON: b64u.enc(credential.response.clientDataJSON),
      ...(transports.length ? { transports } : {}),
    },
  };
}

/** webauthn-rs RequestChallengeResponse JSON -> credentials.get options */
export function parseRequestOptions(json, prfSalt) {
  const pk = json.publicKey;
  const options = {
    ...pk,
    challenge: b64u.dec(pk.challenge),
    allowCredentials: (pk.allowCredentials ?? []).map((c) => ({ ...c, id: b64u.dec(c.id) })),
  };
  if (prfSalt) {
    options.extensions = { ...(options.extensions ?? {}), prf: { eval: { first: prfSalt } } };
  }
  return options;
}

/** get() result -> webauthn-rs PublicKeyCredential JSON */
export function serializeAssertion(credential) {
  return {
    id: credential.id,
    rawId: b64u.enc(credential.rawId),
    type: credential.type,
    extensions: {},
    response: {
      authenticatorData: b64u.enc(credential.response.authenticatorData),
      clientDataJSON: b64u.enc(credential.response.clientDataJSON),
      signature: b64u.enc(credential.response.signature),
      userHandle: credential.response.userHandle
        ? b64u.enc(credential.response.userHandle)
        : null,
    },
  };
}

/** The PRF secret from a get() result, or null if unsupported. */
export function prfSecret(credential) {
  const results = credential.getClientExtensionResults?.()?.prf?.results;
  return results?.first ? new Uint8Array(results.first) : null;
}

/** Translate the DOM's opaque WebAuthn failures into something a person
    can act on. NotAllowedError in particular is iOS/Safari's answer to
    everything: cancelled, timed out, or a second ceremony attempted
    without a fresh tap. */
export function explainWebAuthnError(e, fallback) {
  if (e?.name === 'NotAllowedError') {
    return new Error(
      'passkey prompt was cancelled or timed out — tap the button and approve in one go'
    );
  }
  if (e?.name === 'SecurityError') {
    return new Error('passkey rejected: this page’s domain does not match the relay’s RP_ID');
  }
  if (e?.name === 'InvalidStateError') {
    return new Error('a passkey for this account already exists on this authenticator');
  }
  return fallback ? new Error(`${fallback}: ${e.message}`) : e;
}

/** PRF derivation right after registration: a self-challenged assertion
    (the challenge doesn't matter — PRF output depends only on the
    credential and the salt). Fallback path for authenticators that do
    not evaluate PRF during create(); note iOS will refuse this second
    ceremony unless it gets its own user gesture. */
export async function derivePrfSecret(credentialRawId, prfSalt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialRawId }],
      userVerification: 'preferred',
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  return prfSecret(assertion);
}
