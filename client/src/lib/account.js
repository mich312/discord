// Account vaults: securing an identity so it survives a lost device, and
// unlocking it on a new one.
//
// Extracted from `Controller` (plan §2.2). The controller kept this next to
// boot, the relay socket and the message log, which meant the sign-in paths —
// the ones deciding whether a device may adopt an identity — could only be
// exercised by starting the whole app in a browser.
//
// The seam is deliberate: **unlocking returns the identity bytes, it does not
// adopt them.** Deciding that a vault opened belongs here; installing an
// identity, booting the worker and re-joining every circle belongs to the
// controller. Splitting there is what makes the vault logic testable without
// a worker, and it keeps the irreversible half in one place.
//
// What never appears here, on either side of the split: the wrap key. A
// password vault hands the relay an Argon2id *auth* half and a verifier; the
// *wrap* half never leaves the device. A passkey vault hands over nothing
// derivable at all — the PRF secret comes from the authenticator each time.

import { b64 } from './relay.js';
import { b64url, decryptBlob, encryptBlob } from './invite.js';
import {
  VAULT_PRF_SALT,
  derivePrfSecret,
  parseCreationOptions,
  parseRequestOptions,
  prfSecret,
  serializeAssertion,
  serializeRegistration,
} from './webauthn.js';

/** Shortest password we will seal a vault under. The relay stores a verifier,
    so a weak one is offline-grindable by the operator — an accepted risk in
    the threat model, and this is the floor under it. */
export const MIN_PASSWORD = 8;

/** Kept in step with `MAX_DEVICE_LABEL` in relay/src/server.rs, which is the
    one that actually enforces it. */
export const DEVICE_LABEL_MAX = 64;

/**
 * A default name for the device being enrolled, e.g. "Firefox on Windows".
 *
 * Only ever a convenience: the user is choosing which device to cut off from
 * this list, so the label has to be recognisable, and a bare credential id
 * never is. Deliberately coarse — the alternative is fingerprinting the
 * browser to produce a prettier string, which is not a trade this app should
 * make for a cosmetic field. Falls back to "this device" rather than
 * guessing, because a confidently wrong name is worse than no name when the
 * decision is "revoke that one".
 */
export function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  const os =
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /CrOS/i.test(ua) ? 'ChromeOS'
    : /Linux/i.test(ua) ? 'Linux'
    : null;
  // Order matters: every Chromium UA also says Safari, and Edge says both.
  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'this device';
}

/** Guidance when a browser won't produce the passkey PRF secret the vault is
    encrypted under — common on Chromium (Edge/Chrome) on macOS, where Safari
    does support it. */
export function noPrfMessage() {
  return (
    "this browser didn’t provide the passkey PRF extension we need to encrypt your vault. " +
    'On a Mac, Safari supports it; otherwise secure this account with a password, or link ' +
    'this device from one you’re already signed in on.'
  );
}

/**
 * Turn a failed HTTP response into the error the UI shows.
 *
 * Separate and pure because the 404 wording is load-bearing: `accountKind`
 * distinguishes "that handle has no vault" from a real failure by matching on
 * this text, so changing it silently changes sign-in behaviour.
 */
export function accountError(status, text) {
  return new Error(status === 404 ? 'no such account' : text || `HTTP ${status}`);
}

/** Does this message mean "that handle simply has no server vault"? */
export function isNoAccount(message) {
  return /no such account|no vault|404/i.test(String(message ?? ''));
}

/** The error raised when a passkey proved who you are but this device cannot
    reproduce the key that sealed the vault — an older per-account salt, or a
    PRF that differs across devices. Carries `linkFallback` so the gate can
    offer device linking instead of reading it as corruption. */
export function unlockableHereError() {
  const e = new Error("this device can't unlock your vault with that passkey");
  e.linkFallback = true;
  return e;
}

export class AccountService {
  /**
   * @param deps.request        send on the authenticated relay socket. A
   *                            function, not the connection: the socket does
   *                            not exist yet when this is constructed.
   * @param deps.crypto         worker RPC, for `deriveLoginKeys`
   * @param deps.db             device store, for the local "secured" flag
   * @param deps.dispatch       UI dispatch
   * @param deps.httpBase       () => origin for the pre-auth HTTP endpoints
   * @param deps.identityBytes  () => this device's identity key
   *
   * `credentials`, `fetchImpl` and `webcrypto` are injected purely so the
   * sign-in paths can be driven in a test; they default to the browser's.
   */
  constructor({
    request,
    crypto,
    db,
    dispatch,
    httpBase,
    identityBytes,
    credentials = globalThis.navigator?.credentials,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    webcrypto = globalThis.crypto,
  }) {
    this.request = request;
    this.crypto = crypto;
    // A thunk, for the same reason `request` is one: the controller is built
    // before IndexedDB is open and assigns `db` onto itself afterwards.
    // Captured by value this stayed null for the life of the process, so
    // every `status()` threw on it — which is why the banner telling you your
    // account exists only in this browser never appeared for anybody.
    this.store = db;
    this.dispatch = dispatch;
    this.httpBase = httpBase;
    this.identityBytes = identityBytes;
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.webcrypto = webcrypto;
  }

  /* --- the pre-auth HTTP surface --------------------------------------- */

  /** The sign-in endpoints are reachable before this device has an identity,
      so they are plain HTTP rather than the authenticated socket. */
  async fetch(path, body) {
    const res = await this.fetchImpl(`${this.httpBase()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw accountError(res.status, await res.text());
    return res.json();
  }

  params(user) {
    return this.fetch(`/account/${encodeURIComponent(user)}/params`);
  }

  /* --- status ----------------------------------------------------------- */

  async status() {
    try {
      const reply = await this.request({ t: 'vault_status' });
      const securedLocal = (await this.store().kvGet('securedLocal')) ?? true;
      this.dispatch({ type: 'vault', kind: reply.kind ?? null, securedLocal });
    } catch (e) {
      console.warn(`vault status: ${e.message}`);
    }
  }

  async markSecuredLocal() {
    await this.store().kvPut('securedLocal', true);
    await this.status();
  }

  /* --- securing this identity ------------------------------------------- */

  /** Password vault: Argon2id splits into an auth half (the relay stores only
      its hash) and a wrap half (encrypts the identity, never leaves). */
  async secureWithPassword(password) {
    if ((password ?? '').length < MIN_PASSWORD) {
      throw new Error(`password: ${MIN_PASSWORD} characters minimum`);
    }
    const salt = this.webcrypto.getRandomValues(new Uint8Array(16));
    const keys = new Uint8Array(await this.crypto('deriveLoginKeys', { password, salt }));
    const authKey = keys.slice(0, 32);
    const wrapKey = keys.slice(32);
    const verifier = new Uint8Array(await this.webcrypto.subtle.digest('SHA-256', authKey));
    const wrapped = await encryptBlob(wrapKey, this.identityBytes());
    await this.request({
      t: 'vault_set',
      kind: 'password',
      salt: b64.enc(salt),
      verifier: b64.enc(verifier),
      wrapped: b64.enc(wrapped),
      credential: null,
    });
    await this.markSecuredLocal();
  }

  /** Register a WebAuthn credential and get back both it and the relay's
      serialized copy. Shared by the two enrollment paths below. */
  async registerCredential() {
    if (!this.credentials?.create) throw new Error('WebAuthn unavailable in this browser');
    const start = await this.request({ t: 'passkey_register_start' });
    const credential = await this.credentials.create({
      publicKey: parseCreationOptions(JSON.parse(start.payload)),
    });
    const finish = await this.request({
      t: 'passkey_register_finish',
      credential: JSON.stringify(serializeRegistration(credential)),
    });
    // Prefer the PRF value returned at creation; fall back to a fresh
    // assertion for browsers that only evaluate PRF on a get().
    const secret =
      prfSecret(credential) ?? (await derivePrfSecret(credential.rawId, VAULT_PRF_SALT));
    if (!secret) throw new Error(noPrfMessage());
    return { credential, payload: finish.payload, secret };
  }

  /** Passkey vault: park the identity wrapped under the authenticator's PRF
      secret. Nothing brute-forceable is stored anywhere.

      The salt is a constant, not a random one: PRF output is already unique
      per credential, and pinning the salt lets usernameless sign-in derive
      this same wrap key with no prior account lookup. It is still stored on
      the vault so the handle-first path keeps reading it from /params. */
  async secureWithPasskey() {
    const { payload, secret } = await this.registerCredential();
    const wrapped = await encryptBlob(secret, this.identityBytes());
    await this.request({
      t: 'vault_set',
      kind: 'passkey',
      salt: b64.enc(VAULT_PRF_SALT),
      verifier: b64.enc(new Uint8Array(0)),
      wrapped: b64.enc(wrapped),
      credential: payload,
    });
    await this.markSecuredLocal();
  }

  /** Enroll an ADDITIONAL passkey for this device (e.g. Windows Hello) that
      unlocks the same identity, without touching the primary vault or any
      other device's passkey. Each device seals the identity under its own PRF
      secret; the relay keys the wrap by credential id. */
  async enrollDevicePasskey(label = '') {
    const { credential, payload, secret } = await this.registerCredential();
    const wrapped = await encryptBlob(secret, this.identityBytes());
    await this.request({
      t: 'passkey_wrap_add',
      cred_id: b64url.enc(credential.rawId),
      credential: payload,
      salt: b64.enc(VAULT_PRF_SALT),
      wrapped: b64.enc(wrapped),
      // Bounded again server-side; this is only so an over-long paste never
      // makes the round trip.
      label: String(label ?? '').slice(0, DEVICE_LABEL_MAX).trim(),
    });
    await this.markSecuredLocal();
  }

  /* --- device revocation (forward-only) --------------------------------- */

  /** The devices enrolled against this identity, newest first. Metadata only
      — the relay has no endpoint that hands back a wrap. */
  async listDevices() {
    const reply = await this.request({ t: 'passkey_wrap_list' });
    return (reply.devices ?? []).map((d) => ({
      credId: d.cred_id,
      label: d.label ?? '',
      createdAt: Number(d.created_at) * 1000,
    }));
  }

  /**
   * Revoke one device's passkey.
   *
   * Forward-only, and worth being exact about because the word "revoke"
   * promises more than this delivers: it stops that passkey unlocking the
   * identity from now on. It does NOT reach into a device that already holds
   * the identity in local storage — nothing running on this relay can.
   *
   * What it does defeat is the case where the credential outlives the
   * hardware, which for a *synced* passkey (iCloud Keychain, Google Password
   * Manager) is the normal case rather than the exotic one: without this, a
   * recovered or cloned keychain keeps pulling the identity down forever.
   */
  async revokeDevice(credId) {
    await this.request({ t: 'passkey_wrap_del', cred_id: credId });
  }

  /* --- unlocking on a new device ---------------------------------------- */

  /** How (if at all) a handle signs in on this relay, so the gate offers only
      the method that will work. `null` means no server vault for that handle
      — a normal state (the identity was never secured for cross-device use),
      not an error. */
  async accountKind(user) {
    try {
      return (await this.params(user)).kind ?? null;
    } catch (e) {
      if (isNoAccount(e.message)) return null;
      throw e;
    }
  }

  /** Unwrap the vault with a password. Returns the identity bytes; adopting
      them is the caller's job. */
  async unlockWithPassword(user, password) {
    const params = await this.params(user);
    if (params.kind !== 'password') throw new Error(`this account uses ${params.kind} sign-in`);
    const salt = b64.dec(params.salt);
    const keys = new Uint8Array(await this.crypto('deriveLoginKeys', { password, salt }));
    const reply = await this.fetch(`/account/${encodeURIComponent(user)}/login`, {
      auth_key: b64.enc(keys.slice(0, 32)),
    });
    return decryptBlob(keys.slice(32), b64.dec(reply.wrapped)).catch(() => {
      throw new Error('could not decrypt vault — corrupt data');
    });
  }

  /** Unwrap the vault with a named handle's passkey. */
  async unlockWithPasskey(user) {
    if (!this.credentials?.get) throw new Error('this browser has no passkey support');
    const params = await this.params(user);
    if (params.kind !== 'passkey') {
      throw new Error(`this account uses ${params.kind} sign-in, not a passkey`);
    }
    const prfSalt = b64.dec(params.salt);
    const challenge = await this.fetch(
      `/account/${encodeURIComponent(user)}/passkey/challenge`,
      {}
    );
    const assertion = await this.credentials.get({
      publicKey: parseRequestOptions(challenge, prfSalt),
    });
    const secret = prfSecret(assertion);
    if (!secret) throw new Error('authenticator returned no PRF secret');
    const reply = await this.fetch(`/account/${encodeURIComponent(user)}/passkey/login`, {
      assertion: serializeAssertion(assertion),
    });
    return decryptBlob(secret, b64.dec(reply.wrapped)).catch(() => {
      throw new Error('could not decrypt vault — corrupt data');
    });
  }

  /**
   * Usernameless sign-in: no handle. The authenticator offers its resident
   * passkeys, the relay resolves which account signed, and the vault comes
   * back keyed by nothing but the credential. Works only for passkeys sealed
   * under the constant PRF salt (i.e. registered by this version onward).
   *
   * `mediation: 'conditional'` drives passkey autofill: the get() stays
   * pending (non-modal) until the user picks a passkey from the browser's
   * autocomplete, or `signal` aborts it. Omit both for the modal button.
   */
  async unlockWithDiscoverablePasskey({ mediation, signal } = {}) {
    if (!this.credentials?.get) throw new Error('this browser has no passkey support');
    const { session, options } = await this.fetch('/passkey/discover/challenge', {});
    const assertion = await this.credentials.get({
      publicKey: parseRequestOptions(options, VAULT_PRF_SALT),
      mediation,
      signal,
    });
    const secret = prfSecret(assertion);
    if (!secret) {
      throw new Error('this passkey has no PRF secret — sign in with your handle instead');
    }
    const reply = await this.fetch('/passkey/discover/login', {
      session,
      assertion: serializeAssertion(assertion),
    });
    // Here the credential already matched and its signature verified, so a
    // decrypt failure is NOT corruption — it is a passkey sealed under the old
    // per-account salt (registered before one-tap sign-in), or a PRF that
    // differs across devices. The graceful path is linking from a device you
    // are already signed in on, which is what `linkFallback` tells the gate.
    return decryptBlob(secret, b64.dec(reply.wrapped)).catch(() => {
      throw unlockableHereError();
    });
  }
}
