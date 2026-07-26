// Account vaults and sign-in, driven without a browser or a worker — which
// is the point of pulling them out of the controller (plan §2.2). These are
// the paths that decide whether a device may adopt an identity, and before
// the extraction none of them could be reached except by starting the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountService,
  DEVICE_LABEL_MAX,
  MIN_PASSWORD,
  accountError,
  isNoAccount,
  noPrfMessage,
  unlockableHereError,
} from '../src/lib/account.js';
import { b64 } from '../src/lib/relay.js';
import { encryptBlob } from '../src/lib/invite.js';

const IDENTITY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** A service wired to fakes. `routes` maps "METHOD /path" to a responder. */
function service({ routes = {}, relay = async () => ({}), kv = new Map(), deriveKeys } = {}) {
  const sent = [];
  const dispatched = [];
  const requested = [];

  const svc = new AccountService({
    request: async (msg) => {
      requested.push(msg);
      return relay(msg);
    },
    // 64 bytes: the first 32 are the auth half, the rest the wrap half.
    crypto: deriveKeys ?? (async () => new Uint8Array(64).fill(7)),
    db: {
      kvGet: async (k) => kv.get(k),
      kvPut: async (k, v) => void kv.set(k, v),
    },
    dispatch: (a) => dispatched.push(a),
    httpBase: () => 'https://relay.example',
    identityBytes: () => IDENTITY,
    fetchImpl: async (url, init = {}) => {
      const path = url.replace('https://relay.example', '');
      const key = `${init.method ?? 'GET'} ${path}`;
      sent.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
      const route = routes[key];
      if (!route) return { ok: false, status: 404, text: async () => 'not found' };
      return typeof route === 'function' ? route() : route;
    },
    credentials: undefined,
    webcrypto: {
      getRandomValues: (a) => a.fill(9),
      subtle: { digest: async () => new Uint8Array(32).fill(3).buffer },
    },
  });
  return { svc, sent, dispatched, requested, kv };
}

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/* ------------------------------------------------------ error mapping -- */

test('a 404 is reported as a missing account, not as an HTTP code', () => {
  // `accountKind` distinguishes "no vault for that handle" from a real
  // failure by matching on this exact text.
  assert.equal(accountError(404, 'whatever').message, 'no such account');
});

test('other failures keep the server’s own message', () => {
  assert.equal(accountError(500, 'database down').message, 'database down');
  assert.equal(accountError(503, '').message, 'HTTP 503', 'and fall back to the code');
});

test('the missing-account test matches what the server actually says', () => {
  for (const m of ['no such account', 'no vault for bob', 'HTTP 404', 'NO SUCH ACCOUNT']) {
    assert.equal(isNoAccount(m), true, m);
  }
  for (const m of ['database down', 'rate limited', '', undefined]) {
    assert.equal(isNoAccount(m), false, String(m));
  }
});

/* --------------------------------------------------------- accountKind -- */

test('a handle with no vault reports null rather than throwing', () => {
  // This is a normal state — the identity was never secured for cross-device
  // use — so the sign-in gate must be able to ask without handling an error.
  const { svc } = service();
  return svc.accountKind('nobody').then((k) => assert.equal(k, null));
});

test('a handle with a vault reports its kind', async () => {
  const { svc } = service({
    routes: { 'GET /account/bob/params': json({ kind: 'passkey', salt: b64.enc(new Uint8Array(4)) }) },
  });
  assert.equal(await svc.accountKind('bob'), 'passkey');
});

test('a real failure is not swallowed as "no account"', async () => {
  // Reporting a database outage as "no such account" would send someone to
  // create a second identity while their first one is still there.
  const { svc } = service({
    routes: {
      'GET /account/bob/params': { ok: false, status: 500, text: async () => 'database down' },
    },
  });
  await assert.rejects(() => svc.accountKind('bob'), /database down/);
});

test('a handle is URL-encoded on the way out', async () => {
  const { svc, sent } = service();
  await svc.accountKind('a/b?c');
  assert.equal(sent[0].key, 'GET /account/a%2Fb%3Fc/params');
});

/* ------------------------------------------------ securing with a password -- */

test('a short password is refused before anything is sent', async () => {
  const { svc, requested } = service();
  await assert.rejects(() => svc.secureWithPassword('short'), /8 characters/);
  assert.equal(requested.length, 0, 'nothing reaches the relay');
});

test('a missing password is refused rather than treated as empty', async () => {
  const { svc } = service();
  await assert.rejects(() => svc.secureWithPassword(undefined), /minimum/);
  assert.equal(MIN_PASSWORD, 8);
});

test('only the auth half and a verifier ever leave the device', async () => {
  // The guarantee this whole design rests on: the relay gets something it can
  // check a password against, never something it can unwrap the identity
  // with. A regression here is silent and total.
  const derived = new Uint8Array(64);
  derived.fill(0xaa, 0, 32); // auth half
  derived.fill(0xbb, 32); // wrap half — must never appear on the wire
  const { svc, requested } = service({ deriveKeys: async () => derived });

  await svc.secureWithPassword('a-good-password');
  const [vault] = requested.filter((m) => m.t === 'vault_set');
  assert.equal(vault.kind, 'password');

  const wire = JSON.stringify(vault);
  assert.equal(wire.includes(b64.enc(derived.slice(32))), false, 'the wrap key must not be sent');
  assert.equal(wire.includes(b64.enc(derived.slice(0, 32))), false, 'nor the auth key itself');
  assert.equal(wire.includes(b64.enc(IDENTITY)), false, 'nor the bare identity');
  assert.ok(vault.verifier, 'a verifier is sent instead');
  assert.ok(vault.wrapped, 'and the sealed identity');
});

test('securing marks the device as secured locally', async () => {
  const { svc, kv } = service({ relay: async () => ({ kind: 'password' }) });
  await svc.secureWithPassword('a-good-password');
  assert.equal(kv.get('securedLocal'), true);
});

/* ------------------------------------------------------- unlocking ----- */

test('a password vault round-trips: what is sealed is what comes back', async () => {
  // The end-to-end property, with the real crypto: seal an identity under the
  // wrap half, hand the relay only the auth half, unwrap it again.
  const keys = new Uint8Array(64);
  keys.fill(0xaa, 0, 32);
  keys.fill(0xbb, 32);
  const wrapped = await encryptBlob(keys.slice(32), IDENTITY);

  const { svc, sent } = service({
    deriveKeys: async () => keys,
    routes: {
      'GET /account/bob/params': json({ kind: 'password', salt: b64.enc(new Uint8Array(16)) }),
      'POST /account/bob/login': json({ wrapped: b64.enc(wrapped) }),
    },
  });

  const identity = await svc.unlockWithPassword('bob', 'a-good-password');
  assert.deepEqual(new Uint8Array(identity), IDENTITY);

  const login = sent.find((s) => s.key === 'POST /account/bob/login');
  assert.equal(login.body.auth_key, b64.enc(keys.slice(0, 32)), 'only the auth half is presented');
});

test('a wrong password reports corruption rather than leaking which half failed', async () => {
  const right = new Uint8Array(64).fill(0xbb);
  const wrapped = await encryptBlob(right.slice(32), IDENTITY);
  const wrong = new Uint8Array(64).fill(0xcc);

  const { svc } = service({
    deriveKeys: async () => wrong,
    routes: {
      'GET /account/bob/params': json({ kind: 'password', salt: b64.enc(new Uint8Array(16)) }),
      'POST /account/bob/login': json({ wrapped: b64.enc(wrapped) }),
    },
  });
  await assert.rejects(() => svc.unlockWithPassword('bob', 'wrong-password'), /corrupt data/);
});

test('a password sign-in against a passkey account is refused up front', async () => {
  // Otherwise it fails later with an opaque decrypt error.
  const { svc } = service({
    routes: { 'GET /account/bob/params': json({ kind: 'passkey', salt: b64.enc(new Uint8Array(4)) }) },
  });
  await assert.rejects(() => svc.unlockWithPassword('bob', 'a-good-password'), /uses passkey/);
});

test('unlocking returns the identity and never adopts it', async () => {
  // The split that keeps the irreversible half in the controller: this
  // service has no way to install an identity, by construction.
  const { svc } = service();
  assert.equal(typeof svc.restoreIdentity, 'undefined');
  assert.equal(typeof svc.completeOnboarding, 'undefined');
});

/* ---------------------------------------------------------- passkeys --- */

test('passkey paths refuse cleanly in a browser without WebAuthn', async () => {
  // `credentials` is undefined in this harness, standing in for a browser
  // that has no WebAuthn at all.
  const { svc } = service();
  await assert.rejects(() => svc.registerCredential(), /WebAuthn unavailable/);
  await assert.rejects(() => svc.unlockWithPasskey('bob'), /no passkey support/);
  await assert.rejects(() => svc.unlockWithDiscoverablePasskey(), /no passkey support/);
});

test('the no-PRF message names the workaround instead of just failing', () => {
  // This is the most common passkey failure — Chromium on macOS — and a bare
  // "PRF unavailable" leaves someone stuck with no next step.
  const m = noPrfMessage();
  assert.match(m, /Safari/, 'says where it does work');
  assert.match(m, /password/, 'and offers the alternative');
  assert.match(m, /link/, 'and the other alternative');
});

test('a vault this device cannot open is distinguished from a corrupt one', async () => {
  // The credential already matched and its signature verified, so this is a
  // salt/PRF mismatch, not corruption — and the gate offers device linking
  // rather than telling someone their account is broken.
  const e = unlockableHereError();
  assert.equal(e.linkFallback, true);
  assert.match(e.message, /can't unlock/);
});

/* ------------------------------------------------- device revocation -- */

test('listing devices normalizes the wire shape and keeps nothing else', () => {
  // The relay answers with metadata only; this asserts the client does not
  // invent a place to put a wrap even if one were ever added to the reply.
  const { svc } = service({
    relay: async (msg) =>
      msg.t === 'passkey_wrap_list'
        ? {
            devices: [
              { cred_id: 'c1', label: 'laptop', created_at: 1700, wrapped: 'SEALED' },
              { cred_id: 'c2', label: '', created_at: 1600 },
            ],
          }
        : {},
  });
  return svc.listDevices().then((devices) => {
    assert.deepEqual(devices, [
      { credId: 'c1', label: 'laptop', createdAt: 1700_000 },
      { credId: 'c2', label: '', createdAt: 1600_000 },
    ]);
    assert.ok(
      !JSON.stringify(devices).includes('SEALED'),
      'a wrap in the reply must not survive into client state'
    );
  });
});

test('an empty device list is a list, not a crash', async () => {
  const { svc } = service({ relay: async () => ({}) });
  assert.deepEqual(await svc.listDevices(), []);
});

test('revoking sends the credential id and nothing else', async () => {
  const { svc, requested } = service({ relay: async () => ({}) });
  await svc.revokeDevice('cred-abc');
  assert.deepEqual(requested, [{ t: 'passkey_wrap_del', cred_id: 'cred-abc' }]);
});

test('a device label is bounded and trimmed before it is sent', async () => {
  // The relay bounds it too — this only stops an over-long paste making the
  // round trip, and keeps the stored value from carrying stray whitespace.
  const { svc, requested } = service({ relay: async () => ({}) });
  svc.registerCredential = async () => ({
    credential: { rawId: new Uint8Array([1, 2, 3]) },
    payload: '{}',
    secret: new Uint8Array(32).fill(4),
  });
  await svc.enrollDevicePasskey(`  ${'x'.repeat(200)}  `);
  const sent = requested.find((m) => m.t === 'passkey_wrap_add');
  assert.equal(sent.label.length, DEVICE_LABEL_MAX - 2, 'sliced first, then trimmed');
  assert.ok(!sent.label.includes(' '));
});

test('enrolling without a label sends an empty one rather than undefined', async () => {
  const { svc, requested } = service({ relay: async () => ({}) });
  svc.registerCredential = async () => ({
    credential: { rawId: new Uint8Array([1, 2, 3]) },
    payload: '{}',
    secret: new Uint8Array(32).fill(4),
  });
  await svc.enrollDevicePasskey();
  assert.equal(requested.find((m) => m.t === 'passkey_wrap_add').label, '');
});
