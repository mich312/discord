// Web Worker owning the MLS client. The main thread talks to it with
// {id, cmd, ...args} messages and gets {id, ok, result} | {id, ok:false,
// error} back. Key material never leaves this worker — the main thread
// only ever sees ciphertext blobs (Uint8Array) and decrypted events.
import init, { Client } from '/pkg/crypto_core.js';

let client = null;

const commands = {
  async init({ name }) {
    await init();
    client = new Client(name);
    return { name };
  },
  createGroup({ group }) {
    client.createGroup(group);
    return { epoch: Number(client.epoch(group)) };
  },
  keyPackage() {
    return client.keyPackage();
  },
  pubkey() {
    return client.signaturePublicKey();
  },
  sign({ bytes }) {
    return client.sign(bytes);
  },
  addMember({ group, keyPackage }) {
    const r = client.addMember(group, keyPackage);
    return {
      commit: r.commit,
      welcome: r.welcome,
      epoch: Number(client.epoch(group)),
      members: client.members(group),
    };
  },
  joinFromWelcome({ welcome }) {
    const group = client.joinFromWelcome(welcome);
    return { group, epoch: Number(client.epoch(group)), members: client.members(group) };
  },
  send({ group, text }) {
    return client.send(group, text);
  },
  receive({ bytes }) {
    const event = client.receive(bytes);
    if (event.epoch !== undefined) event.epoch = Number(event.epoch);
    return event;
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
