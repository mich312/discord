// WebAuthn plumbing: convert between webauthn-rs JSON (base64url strings)
// and the browser API (ArrayBuffers), and run the PRF extension that
// turns a passkey into a deterministic wrap key for the identity vault.

// The identity vault's PRF salt. WebAuthn PRF output is already unique per
// credential, so this salt need not be secret or per-account — pinning it to a
// constant is what lets usernameless sign-in derive the wrap key without first
// looking the account up. NEVER change these bytes: doing so would orphan every
// vault ever sealed under a passkey. (Exactly 32 ASCII bytes.)
export const VAULT_PRF_SALT = new TextEncoder().encode('quorum/passkey-vault/prf/salt/v1');

const b64u = {
  enc: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, ''),
  dec: (s) =>
    Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
};

/** webauthn-rs CreationChallengeResponse JSON -> credentials.create options */
export function parseCreationOptions(json, prf = true) {
  const pk = json.publicKey;
  const options = {
    ...pk,
    challenge: b64u.dec(pk.challenge),
    user: { ...pk.user, id: b64u.dec(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({ ...c, id: b64u.dec(c.id) })),
  };
  // Force a discoverable (resident) credential. webauthn-rs's
  // start_passkey_registration doesn't request one, but usernameless sign-in
  // depends on the authenticator storing the passkey so it can offer it with
  // no handle. Platform authenticators (Touch ID, Windows Hello, phones) all
  // support this; it's the standard passkey shape.
  options.authenticatorSelection = {
    ...(pk.authenticatorSelection ?? {}),
    residentKey: 'required',
    requireResidentKey: true,
  };
  if (prf) options.extensions = { ...(options.extensions ?? {}), prf: {} };
  return options;
}

/** create() result -> webauthn-rs RegisterPublicKeyCredential JSON */
export function serializeRegistration(credential) {
  return {
    id: credential.id,
    rawId: b64u.enc(credential.rawId),
    type: credential.type,
    extensions: {},
    response: {
      attestationObject: b64u.enc(credential.response.attestationObject),
      clientDataJSON: b64u.enc(credential.response.clientDataJSON),
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

/** PRF derivation right after registration: a self-challenged assertion
    (the challenge doesn't matter — PRF output depends only on the
    credential and the salt). */
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
