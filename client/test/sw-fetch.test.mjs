// The service worker's fetch handler, driven directly. An offline shell
// fails in ways that are invisible until someone is stranded: a pinned
// index.html that never updates, attachments silently eating the origin
// quota, a WebSocket intercepted and broken. None of that is caught by a
// build succeeding, so it is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
const ORIGIN = 'https://quorum.example';
const ASSETS = ['/index.html', '/assets/app-abc.js', '/worker.js'];

/** Load the worker with a stubbed environment and a real manifest baked in,
 *  the way the build does. Returns the handlers plus the fake cache. */
// `assets` is what the build baked into the manifest; `available` is what the
// server will actually serve. They are the same in a healthy deploy and
// deliberately not in the test that covers a missing file.
function loadWorker({ assets = ASSETS, available = assets, cached = new Map(), online = true } = {}) {
  const handlers = {};
  const stores = new Map([[`quorum-shell-v1`, cached]]);
  const fetched = [];

  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        add: async (req) => {
          const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN);
          if (!online) throw new Error('offline');
          if (!available.includes(url.pathname)) throw new Error('404');
          store.set(url.pathname, { body: url.pathname, from: 'cache' });
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req, { cacheName } = {}) => {
      const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN);
      const store = cacheName ? stores.get(cacheName) : [...stores.values()][0];
      return store?.get(url.pathname);
    },
  };

  const ctx = {
    console,
    caches,
    indexedDB: {},
    fetch: async (req) => {
      fetched.push(typeof req === 'string' ? req : req.url);
      if (!online) throw new TypeError('network error');
      return { body: 'network', from: 'network' };
    },
    Response: { error: () => ({ from: 'browser-offline-page' }) },
    Request: class {
      constructor(url, opts) {
        this.url = String(url);
        Object.assign(this, opts);
      }
    },
    URL,
    JSON,
    Promise,
    self: {
      addEventListener: (k, f) => {
        handlers[k] = f;
      },
      location: { origin: ORIGIN },
      registration: {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      skipWaiting: async () => {},
    },
  };
  ctx.self.self = ctx.self;
  createContext(ctx);
  runInContext(SRC.replace('__SHELL_MANIFEST__', JSON.stringify({ version: 'v1', assets })), ctx);
  return { handlers, stores, fetched, ctx };
}

/** Run an install/activate handler to completion. The handler returns
 *  immediately and hands its real work to waitUntil, so awaiting the call
 *  alone proves nothing. */
async function lifecycle(handler) {
  let work = Promise.resolve();
  handler({ waitUntil: (p) => (work = p) });
  await work;
}

/** Drive the fetch handler and return whatever it responded with, or the
 *  sentinel PASS when it declined to handle the request at all. */
const PASS = Symbol('not handled');
async function fetchThrough(handlers, url, init = {}) {
  let answer = PASS;
  await handlers.fetch({
    request: { url, method: 'GET', mode: 'same-origin', ...init },
    respondWith: (p) => {
      answer = p;
    },
  });
  return answer === PASS ? PASS : await answer;
}

/* -------------------------------------------------------------- install -- */

test('install precaches the shell', async () => {
  const { handlers, stores } = loadWorker();
  await lifecycle(handlers.install);
  assert.deepEqual([...stores.get('quorum-shell-v1').keys()].sort(), [...ASSETS].sort());
});

test('one unfetchable asset does not cost the whole shell', async () => {
  // addAll is all-or-nothing: a single renamed icon would leave the app with
  // no offline shell at all rather than a slightly incomplete one.
  const { handlers, stores } = loadWorker({ assets: [...ASSETS, '/gone.png'], available: ASSETS });
  await lifecycle(handlers.install);
  const keys = [...stores.get('quorum-shell-v1').keys()];
  assert.equal(keys.includes('/gone.png'), false);
  assert.ok(keys.includes('/index.html'), 'the rest of the shell is still cached');
});

/* ------------------------------------------------------------- activate -- */

test('activate drops caches from previous builds', async () => {
  const { handlers, stores } = loadWorker();
  stores.set('quorum-shell-OLD', new Map([['/index.html', {}]]));
  await lifecycle(handlers.activate);
  assert.deepEqual([...stores.keys()], ['quorum-shell-v1']);
});

test('activate leaves caches belonging to anything else alone', async () => {
  const { handlers, stores } = loadWorker();
  stores.set('some-other-app', new Map());
  await lifecycle(handlers.activate);
  assert.ok([...stores.keys()].includes('some-other-app'));
});

/* ---------------------------------------------------------------- fetch -- */

test('a navigation prefers the network so updates land', async () => {
  // index.html is not content-hashed. Cache-first here would pin the app at
  // whichever version happened to be cached first.
  const { handlers, fetched } = loadWorker({
    cached: new Map([['/index.html', { from: 'cache' }]]),
  });
  const res = await fetchThrough(handlers, `${ORIGIN}/`, { mode: 'navigate' });
  assert.equal(res.from, 'network');
  assert.equal(fetched.length, 1);
});

test('a navigation with no network falls back to the cached shell', async () => {
  // This is the whole feature: the messages are already in IndexedDB, and
  // until now the app showed a blank page anyway.
  const { handlers } = loadWorker({
    online: false,
    cached: new Map([['/index.html', { from: 'cache' }]]),
  });
  const res = await fetchThrough(handlers, `${ORIGIN}/`, { mode: 'navigate' });
  assert.equal(res.from, 'cache');
});

test('offline with nothing cached yields the browser offline page, not a blank 200', async () => {
  const { handlers } = loadWorker({ online: false });
  const res = await fetchThrough(handlers, `${ORIGIN}/`, { mode: 'navigate' });
  assert.equal(res.from, 'browser-offline-page');
});

test('a precached asset is served from the cache', async () => {
  const { handlers, fetched } = loadWorker({
    cached: new Map([['/assets/app-abc.js', { from: 'cache' }]]),
  });
  const res = await fetchThrough(handlers, `${ORIGIN}/assets/app-abc.js`);
  assert.equal(res.from, 'cache');
  assert.equal(fetched.length, 0, 'no network round trip for a cached hashed asset');
});

test('a shell asset missing from the cache falls through to the network', async () => {
  const { handlers } = loadWorker();
  const res = await fetchThrough(handlers, `${ORIGIN}/assets/app-abc.js`);
  assert.equal(res.from, 'network');
});

test('attachments are never intercepted', async () => {
  // Large, and they would compete for the same origin quota as the message
  // store — which this app already has to fight for on iOS.
  const { handlers } = loadWorker();
  assert.equal(await fetchThrough(handlers, `${ORIGIN}/blob/abc123`), PASS);
});

test('relay traffic is never intercepted', async () => {
  const { handlers } = loadWorker();
  for (const path of ['/healthz', '/ws', '/register/policy']) {
    assert.equal(await fetchThrough(handlers, `${ORIGIN}${path}`), PASS, path);
  }
});

test('cross-origin requests are none of our business', async () => {
  // A game iframe, a STUN/TURN probe, anything else.
  const { handlers } = loadWorker();
  assert.equal(await fetchThrough(handlers, 'https://elsewhere.example/g.js'), PASS);
});

test('non-GET requests are never intercepted', async () => {
  const { handlers } = loadWorker();
  assert.equal(
    await fetchThrough(handlers, `${ORIGIN}/index.html`, { method: 'POST' }),
    PASS,
  );
});

test('an unbuilt worker intercepts nothing at all', async () => {
  // In dev the placeholder is still literal. Serving a half-configured shell
  // there would break hot reload in a way that looks like a code bug.
  const { handlers } = loadWorker({ assets: [] });
  assert.equal(await fetchThrough(handlers, `${ORIGIN}/`, { mode: 'navigate' }), PASS);
  assert.equal(await fetchThrough(handlers, `${ORIGIN}/assets/app-abc.js`), PASS);
});

test('a malformed request url is passed through rather than thrown on', async () => {
  const { handlers } = loadWorker();
  assert.equal(await fetchThrough(handlers, 'not a url'), PASS);
});
