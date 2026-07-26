// Web Worker owning the MLS client. Key material never leaves this worker;
// the main thread sees only ciphertext blobs, decrypted events, and opaque
// state snapshots it persists to IndexedDB.
//
// Mutating commands piggyback a fresh full-state snapshot (`state`) on
// their result so the main thread can persist after every ratchet turn.
import init, { Client, deriveLoginKeys } from '/pkg/crypto_core.js';

// Replaced at build time by client/scripts/inject-integrity.mjs with the
// SHA-384 of the wasm this build shipped. Left literal in dev, where the
// artifact changes on every rebuild and there is nothing stable to pin.
const WASM_INTEGRITY = '__WASM_INTEGRITY__';

/**
 * Fetch the wasm, check it against the hash this build was made with, and
 * only then instantiate.
 *
 * Be clear about what this does and does not buy. It does NOT defend against
 * a hostile operator: they serve worker.js too, so they would change both.
 * What it does catch is the wasm being wrong *on its own* — a partial deploy,
 * a poisoned or stale cache, a CDN serving a different build than the page —
 * and it is what makes the published hashes in `integrity.json` checkable by
 * someone who does not trust the deployment. Reproducible builds remain the
 * only real answer to operator-served code; see docs/THREAT_MODEL.md §6.2.
 */
async function initVerified() {
  if (WASM_INTEGRITY.startsWith('__')) return init(); // dev: nothing to pin
  const res = await fetch('/pkg/crypto_core_bg.wasm');
  if (!res.ok) throw new Error(`could not fetch the crypto core: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  const got = `sha384-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
  if (got !== WASM_INTEGRITY) {
    // Fail closed and loudly. Running a crypto core that is not the one this
    // build was tested with is worse than not running at all.
    throw new Error(
      `the encryption core failed its integrity check (expected ${WASM_INTEGRITY}, got ${got}) — ` +
        'refusing to load it'
    );
  }
  return init(bytes);
}

let client = null;
let initPromise = null;
const ensureInit = () => (initPromise ??= initVerified());

const snapshot = () => client.exportState();

const commands = {
  /** Create fresh, restore from device snapshot, or from recovery identity. */
  async boot({ name, state, identity }) {
    await ensureInit();
    if (state) client = Client.fromState(state);
    else if (identity) client = Client.fromIdentity(identity);
    else client = new Client(name);
    return { name: client.name, groups: client.groupIds(), state: snapshot() };
  },
  pubkey() {
    return client.signaturePublicKey();
  },
  // Pre-boot: sign-in derives keys before any identity exists locally.
  async deriveLoginKeys({ password, salt }) {
    await ensureInit();
    return deriveLoginKeys(password, salt);
  },
  sign({ bytes }) {
    return client.sign(bytes);
  },
  exportIdentity() {
    return client.exportIdentity();
  },
  keyPackage() {
    // KeyPackage private parts land in storage — snapshot so the later
    // Welcome (possibly after a reload) can still find them.
    return { keyPackage: client.keyPackage(), state: snapshot() };
  },
  createGroup({ group }) {
    client.createGroup(group);
    return { epoch: Number(client.epoch(group)), state: snapshot() };
  },
  // add/removeMember STAGE a commit — they no longer advance the epoch.
  // `epoch` is the epoch this commit will produce once the relay accepts
  // it into the log; members/roster only move on mergeStagedCommit.
  addMember({ group, keyPackage, expectIdentity, expectKey }) {
    const r = client.addMember(group, keyPackage, expectIdentity, expectKey);
    return {
      commit: r.commit,
      welcome: r.welcome,
      epoch: Number(client.epoch(group)) + 1,
      state: snapshot(),
    };
  },
  removeMember({ group, name }) {
    const commit = client.removeMember(group, name);
    return {
      commit,
      epoch: Number(client.epoch(group)) + 1,
      state: snapshot(),
    };
  },
  /** The relay accepted our staged commit: adopt it. */
  mergeStagedCommit({ group }) {
    const epoch = Number(client.mergeStagedCommit(group));
    return { epoch, members: client.members(group), state: snapshot() };
  },
  /** The relay refused it (someone else won this epoch): drop it and stay
      put, so the winning commit can be processed like any other. */
  discardStagedCommit({ group }) {
    client.discardStagedCommit(group);
    return {
      epoch: Number(client.epoch(group)),
      members: client.members(group),
      state: snapshot(),
    };
  },
  /** Drop a group from the local MLS client — used when leaving, being
      kicked, or deleting. No ratchet turn; just forget the keys. */
  forgetGroup({ group }) {
    client.forgetGroup(group);
    return { state: snapshot() };
  },
  exportGroupInfo({ group }) {
    // Read-only: GroupInfo export doesn't turn any ratchet.
    return client.exportGroupInfo(group);
  },
  joinByExternalCommit({ groupInfo }) {
    const r = client.joinByExternalCommit(groupInfo);
    return {
      group: r.group,
      commit: r.commit,
      epoch: Number(client.epoch(r.group)),
      members: client.members(r.group),
      state: snapshot(),
    };
  },
  joinFromWelcome({ welcome }) {
    const group = client.joinFromWelcome(welcome);
    return {
      group,
      epoch: Number(client.epoch(group)),
      members: client.members(group),
      state: snapshot(),
    };
  },
  send({ group, text }) {
    const blob = client.send(group, text);
    return { blob, epoch: Number(client.epoch(group)), state: snapshot() };
  },
  receive({ bytes }) {
    const event = client.receive(bytes);
    if (event.epoch !== undefined) event.epoch = Number(event.epoch);
    return { event, state: snapshot() };
  },
  safetyNumber({ group, peer }) {
    return client.safetyNumber(group, peer);
  },
  status({ group }) {
    return { epoch: Number(client.epoch(group)), members: client.members(group) };
  },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, ...args } = data;
  try {
    const result = await commands[cmd](args);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
