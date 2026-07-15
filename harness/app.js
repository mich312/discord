// Harness main thread: owns the WebSocket to the relay and the (bare) test
// surface. All crypto happens in worker.js. Driven by URL params:
//   ?name=alice&role=create   — create the group, auto-add joiners
//   ?name=bob&role=join       — publish a KeyPackage, join on Welcome
const params = new URLSearchParams(location.search);
const NAME = params.get('name') ?? `anon-${Math.random().toString(36).slice(2, 7)}`;
const ROLE = params.get('role') ?? 'join';
const RELAY = params.get('relay') ?? `ws://${location.hostname}:9601`;

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

// --- worker plumbing -------------------------------------------------------
const worker = new Worker('/worker.js', { type: 'module' });
let nextId = 1;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const { id, ok, result, error } = data;
  const { resolve, reject } = pending.get(id);
  pending.delete(id);
  ok ? resolve(result) : reject(new Error(error));
};
function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...args });
  });
}

// --- relay plumbing --------------------------------------------------------
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const ws = new WebSocket(RELAY);
const sendEnvelope = (type, payload, to) =>
  ws.send(JSON.stringify({ type, from: NAME, to, payload: b64.enc(payload) }));

function updateStatus(epoch, members) {
  statusEl.textContent = `${NAME} · epoch ${epoch} · members: ${members.join(', ')}`;
  window.__state = { name: NAME, epoch, members };
}

ws.onopen = async () => {
  ws.send(JSON.stringify({ type: 'hello', from: NAME }));
  await call('init', { name: NAME });
  if (ROLE === 'create') {
    const { epoch } = await call('createGroup');
    updateStatus(epoch, [NAME]);
    log('system', `created group (epoch ${epoch})`);
  } else {
    const kp = await call('keyPackage');
    sendEnvelope('keypackage', kp);
    log('system', 'published key package, waiting for welcome…');
  }
};

ws.onmessage = async ({ data }) => {
  const envelope = JSON.parse(data);
  const payload = b64.dec(envelope.payload);
  try {
    switch (envelope.type) {
      case 'keypackage': {
        if (ROLE !== 'create') return; // phase 1: only the creator adds
        const { commit, welcome, epoch, members } = await call('addMember', { keyPackage: payload });
        sendEnvelope('welcome', welcome, envelope.from);
        sendEnvelope('mls', commit);
        updateStatus(epoch, members);
        log('system', `added ${envelope.from} (epoch ${epoch})`);
        break;
      }
      case 'welcome': {
        const { epoch, members } = await call('joinFromWelcome', { welcome: payload });
        updateStatus(epoch, members);
        log('system', `joined group (epoch ${epoch}) — members: ${members.join(', ')}`);
        break;
      }
      case 'mls': {
        const event = await call('receive', { bytes: payload });
        if (event.kind === 'message') {
          log('message', `${event.sender}: ${event.text}`);
        } else if (event.kind === 'membershipChange') {
          updateStatus(event.epoch, event.members);
          log('system', `membership changed (epoch ${event.epoch}) — members: ${event.members.join(', ')}`);
        }
        break;
      }
    }
  } catch (e) {
    log('error', `error handling ${envelope.type} from ${envelope.from}: ${e.message}`);
  }
};

// --- composer ---------------------------------------------------------------
const input = document.getElementById('input');
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const blob = await call('send', { text });
  sendEnvelope('mls', blob);
  log('message', `${NAME}: ${text}`);
});
