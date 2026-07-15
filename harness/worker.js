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
  createGroup() {
    client.createGroup();
    return { epoch: Number(client.epoch()) };
  },
  keyPackage() {
    return client.keyPackage();
  },
  addMember({ keyPackage }) {
    const r = client.addMember(keyPackage);
    return { commit: r.commit, welcome: r.welcome, epoch: Number(client.epoch()), members: client.members() };
  },
  joinFromWelcome({ welcome }) {
    client.joinFromWelcome(welcome);
    return { epoch: Number(client.epoch()), members: client.members() };
  },
  send({ text }) {
    return client.send(text);
  },
  receive({ bytes }) {
    const event = client.receive(bytes);
    if (event.epoch !== undefined) event.epoch = Number(event.epoch);
    return event;
  },
  status() {
    return { epoch: Number(client.epoch()), members: client.members() };
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
