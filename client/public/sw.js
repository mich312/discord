// Service worker: shows notifications for Web Push nudges. The push
// payload carries only what the relay knows anyway (a group id and the
// kind of nudge) — message *content* can't appear because the server
// never has it. What we CAN show is device-local knowledge: the circle's
// name, looked up in this device's own IndexedDB.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** The circle's display name from the local store, or null. */
function circleName(id) {
  return new Promise((resolve) => {
    const req = indexedDB.open('e2ee-client', 1);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('servers').objectStore('servers').get(id);
        get.onsuccess = () => {
          db.close();
          resolve(get.result?.name ?? null);
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
