// Harness main thread: drives the real relay protocol. All crypto stays in
// worker.js; this file only moves opaque blobs. Driven by URL params:
//   ?name=alice&role=create&peers=bob   — create group, add peers as their
//                                         KeyPackages appear in the store
//   ?name=bob&role=join                 — publish KeyPackages, join on Welcome
const params = new URLSearchParams(location.search);
const NAME = params.get('name') ?? `anon-${Math.random().toString(36).slice(2, 7)}`;
const ROLE = params.get('role') ?? 'join';
const GROUP = params.get('group') ?? 'main';
const PEERS = (params.get('peers') ?? 'bob').split(',').filter(Boolean);
const RELAY = params.get('relay') ?? `ws://${location.hostname}:9601/ws`;

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
window.__log = []; // structured log for the e2e test to assert on

function log(kind, text) {
  window.__log.push({ kind, text });
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  logEl.append(line);
}

// --- worker plumbing --------------------------------------------------------
const worker = new Worker('/worker.js', { type: 'module' });
let nextCallId = 1;
const pendingCalls = new Map();
worker.onmessage = ({ data }) => {
  const { id, ok, result, error } = data;
  const { resolve, reject } = pendingCalls.get(id);
  pendingCalls.delete(id);
  ok ? resolve(result) : reject(new Error(error));
};
function mls(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...args });
  });
}

// --- relay plumbing ---------------------------------------------------------
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

const ws = new WebSocket(RELAY);
let nextRid = 1;
const pendingRids = new Map();

/** Send a request and await its rid-matched reply; rejects on error reply. */
function request(msg) {
  return new Promise((resolve, reject) => {
    const rid = nextRid++;
    pendingRids.set(rid, { resolve, reject });
    ws.send(JSON.stringify({ ...msg, rid }));
  });
}

function updateStatus(epoch, members) {
  statusEl.textContent = `${NAME} · epoch ${epoch} · members: ${members.join(', ')}`;
  window.__state = { name: NAME, epoch, members };
}

async function handleEvent(msg) {
  switch (msg.t) {
    case 'welcome': {
      if (ROLE !== 'join') return;
      const { epoch, members } = await mls('joinFromWelcome', { welcome: b64.dec(msg.payload) });
      updateStatus(epoch, members);
      log('system', `joined ${msg.group} via welcome from ${msg.from} (epoch ${epoch}) — members: ${members.join(', ')}`);
      await request({ t: 'subscribe', group: msg.group, after: msg.after });
      log('system', `subscribed to ${msg.group} after seq ${msg.after}`);
      break;
    }
    case 'msg': {
      const event = await mls('receive', { bytes: b64.dec(msg.payload) });
      if (event.kind === 'message') {
        log('message', `${event.sender}: ${event.text}`);
      } else if (event.kind === 'membershipChange') {
        updateStatus(event.epoch, event.members);
        log('system', `membership changed (epoch ${event.epoch}) — members: ${event.members.join(', ')}`);
      }
      break;
    }
  }
}

// --- auth handshake ---------------------------------------------------------
const ready = new Promise((resolve) => {
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.t === 'challenge') {
      const nonce = b64.dec(msg.nonce);
      const context = new TextEncoder().encode('relay-auth-v1');
      const signed = new Uint8Array([...context, ...nonce]);
      const sig = await mls('sign', { bytes: signed });
      ws.send(JSON.stringify({ t: 'auth', sig: b64.enc(sig) }));
      return;
    }
    if (msg.t === 'ready') {
      resolve();
      return;
    }
    if (msg.rid !== undefined && pendingRids.has(msg.rid)) {
      const { resolve: res, reject } = pendingRids.get(msg.rid);
      pendingRids.delete(msg.rid);
      msg.t === 'error' ? reject(new Error(msg.message)) : res(msg);
      return;
    }
    try {
      await handleEvent(msg);
    } catch (e) {
      log('error', `error handling ${msg.t}: ${e.message}`);
    }
  };
});

ws.onopen = async () => {
  await mls('init', { name: NAME });
  const pubkey = await mls('pubkey');
  ws.send(JSON.stringify({ t: 'hello', user: NAME, pubkey: b64.enc(pubkey) }));
  await ready;
  log('system', `authenticated as ${NAME}`);

  if (ROLE === 'create') {
    const { epoch } = await mls('createGroup', { group: GROUP });
    await request({ t: 'create_group', group: GROUP });
    updateStatus(epoch, [NAME]);
    log('system', `created group ${GROUP} (epoch ${epoch})`);
    for (const peer of PEERS) addWhenPublished(peer);
  } else {
    const kps = [];
    for (let i = 0; i < 3; i++) kps.push(b64.enc(await mls('keyPackage')));
    await request({ t: 'publish_kp', payloads: kps });
    log('system', 'published key packages, waiting for welcome…');
  }
};

/** Creator: poll the KeyPackage store until `peer` publishes, then add. */
async function addWhenPublished(peer) {
  for (;;) {
    try {
      const reply = await request({ t: 'fetch_kp', user: peer });
      if (reply.payload) {
        const { commit, welcome, epoch, members } = await mls('addMember', {
          group: GROUP,
          keyPackage: b64.dec(reply.payload),
        });
        const sent = await request({ t: 'send', group: GROUP, epoch, payload: b64.enc(commit) });
        await request({ t: 'allow', group: GROUP, user: peer });
        await request({ t: 'welcome', to: peer, group: GROUP, after: sent.seq, payload: b64.enc(welcome) });
        updateStatus(epoch, members);
        log('system', `added ${peer} (epoch ${epoch}, commit seq ${sent.seq})`);
        return;
      }
    } catch (e) {
      log('error', `adding ${peer}: ${e.message}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// --- composer ----------------------------------------------------------------
const input = document.getElementById('input');
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const blob = await mls('send', { group: GROUP, text });
  const { epoch } = await mls('status', { group: GROUP });
  await request({ t: 'send', group: GROUP, epoch, payload: b64.enc(blob) });
  log('message', `${NAME}: ${text}`);
});
