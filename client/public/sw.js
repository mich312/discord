// Service worker: shows notifications for Web Push nudges. The push
// payload carries only what the relay knows anyway (a group id) — message
// content can't appear here because the server never has it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let body = 'new encrypted activity';
  try {
    const data = event.data.json();
    if (data.welcome) body = 'you were added to a group';
    else if (data.group) body = 'new encrypted message';
  } catch {
    /* opaque payload — keep the generic text */
  }
  event.waitUntil(self.registration.showNotification('quorum', { body, tag: 'quorum' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => (windows[0] ? windows[0].focus() : self.clients.openWindow('/')))
  );
});
