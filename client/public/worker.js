// Web Worker owning the MLS client. Key material never leaves this worker;
// the main thread sees only ciphertext blobs, decrypted events, and opaque
// state snapshots it persists to IndexedDB.
//
// Mutating commands piggyback a fresh full-state snapshot (`state`) on
// their result so the main thread can persist after every ratchet turn.
import init, { Client, deriveLoginKeys } from '/pkg/crypto_core.js';

let client = null;
let initPromise = null;
const ensureInit = () => (initPromise ??= init());

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
  addMember({ group, keyPackage }) {
    const r = client.addMember(group, keyPackage);
    return {
      commit: r.commit,
      welcome: r.welcome,
      epoch: Number(client.epoch(group)),
      members: client.members(group),
      state: snapshot(),
    };
  },
  removeMember({ group, name }) {
    const commit = client.removeMember(group, name);
    return {
      commit,
      epoch: Number(client.epoch(group)),
      members: client.members(group),
      state: snapshot(),
    };
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
