// Service worker: two jobs.
//
// 1. Web Push nudges. The push payload carries only what the relay knows
//    anyway (a group id and the kind of nudge) — message *content* can't
//    appear because the server never has it. What we CAN show is
//    device-local knowledge: the circle's name, from this device's IndexedDB.
//
// 2. The offline shell. Every message you have ever read is already on this
//    device, and until now opening the app without a network showed a blank
//    page anyway — the conversation was there and unreachable. The shell is
//    precached so the app boots offline and reads from IndexedDB.

// Replaced at build time by scripts/inject-precache.mjs. Left literal when
// the file is served straight out of public/ (dev), where Vite serves modules
// individually and there is no stable list to cache — push still works.
const SHELL_MANIFEST = '__SHELL_MANIFEST__';
const SHELL = SHELL_MANIFEST.startsWith('__')
  ? { version: 'dev', assets: [] }
  : JSON.parse(SHELL_MANIFEST);

// Version-scoped: a new build writes a new cache and drops the old one, so a
// stale asset cannot outlive the deploy that replaced it. This is the whole
// reason cache-first is safe below.
const CACHE = `quorum-shell-${SHELL.version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (SHELL.assets.length > 0) {
        const cache = await caches.open(CACHE);
        // Individually, not addAll: addAll is all-or-nothing, so one 404 —
        // an icon renamed, a stale manifest — would leave the app with no
        // offline shell at all rather than a slightly incomplete one.
        await Promise.all(
          SHELL.assets.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
          )
        );
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('quorum-shell-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || SHELL.assets.length === 0) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Same-origin only. The relay's WebSocket, blob store and any cross-origin
  // game frame are none of our business.
  if (url.origin !== self.location.origin) return;

  // A navigation is the one request that must prefer the network: index.html
  // is not content-hashed, so serving it from cache first would pin the app
  // at the version that happened to be cached. Falling back to the cached
  // copy is what makes offline boot work.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html', { cacheName: CACHE });
        // No shell cached yet and no network: let the browser show its own
        // offline page rather than an empty 200 that looks like a broken app.
        return cached ?? Response.error();
      })
    );
    return;
  }

  // Everything else is served from the cache only if we precached it. Nothing
  // is added to the cache at runtime: attachments are large and would compete
  // for the same origin quota as the message store, which this app already
  // has to fight for on iOS.
  if (!SHELL.assets.includes(url.pathname)) return;
  event.respondWith(
    caches.match(request, { cacheName: CACHE }).then((hit) => hit ?? fetch(request))
  );
});

/** The circle's display name from the local name cache, or null.
 *
 *  Read from `kv/circleNames` rather than from a circle record, because
 *  there are no circle records on the device any more — they live on the
 *  relay, sealed under a key derived from the identity bundle. A service
 *  worker cannot reach that key (it has no localStorage), so it could not
 *  open the blob even if it fetched it, and it runs precisely when the page
 *  that could is closed. The cache exists for this one caller.
 *
 *  Opened WITHOUT a version on purpose. Naming one pins this reader to a
 *  schema it does not own: asking for version 1 against a database the page
 *  has already upgraded to 3 fails outright with a VersionError, and the
 *  only symptom is push notifications quietly losing the circle's name.
 *  Versionless open takes whatever exists and never triggers an upgrade,
 *  which is what a read-only consumer of someone else's store wants. */
function circleName(id) {
  return new Promise((resolve) => {
    const req = indexedDB.open('e2ee-client');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('kv').objectStore('kv').get('circleNames');
        get.onsuccess = () => {
          db.close();
          resolve(get.result?.[id] ?? null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data.json();
      } catch {
        /* opaque payload — fall through to the generic text */
      }
      let body = 'new encrypted activity';
      // Per-kind, per-circle tags: a second message in the same circle
      // coalesces (renotify still alerts), but a call never replaces a
      // message notification and one circle never swallows another's.
      let tag = 'quorum';
      let requireInteraction = false;
      const group = data.call ?? data.rally ?? data.group ?? data.welcome ?? null;
      const name = group ? await circleName(group) : null;
      if (data.welcome) {
        body = name ? `you were added to “${name}”` : 'you were added to a circle';
        tag = `quorum-welcome-${data.welcome}`;
      } else if (data.call) {
        body = name ? `incoming call in “${name}”` : 'incoming call';
        tag = `quorum-call-${data.call}`;
        requireInteraction = true; // a ring should stay up until acted on
      } else if (data.rally) {
        body = name ? `a rally was started in “${name}”` : 'a rally was started';
        tag = `quorum-rally-${data.rally}`;
      } else if (data.group) {
        body = name ? `new message in “${name}”` : 'new encrypted message';
        tag = `quorum-msg-${data.group}`;
      }
      await self.registration.showNotification('quorum', {
        body,
        tag,
        renotify: true,
        requireInteraction,
        data: { group },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const group = event.notification.data?.group ?? null;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const win = windows[0];
        if (win) {
          if (group) win.postMessage({ type: 'open-group', group });
          return win.focus();
        }
        return self.clients.openWindow('/');
      })
  );
});
