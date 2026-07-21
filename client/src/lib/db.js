// IndexedDB, promisified, three stores:
//   kv       — mls state snapshot, session record
//   servers  — {id, name, channels[], members[], epoch, lastSeq}
//   messages — {server, channel, sender, text, ts, system?}, indexed by channel
const DB_NAME = 'e2ee-client';

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('servers', { keyPath: 'id' });
      const messages = db.createObjectStore('messages', { autoIncrement: true });
      messages.createIndex('byChannel', ['server', 'channel']);
    };
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

function wrap(db) {
  return {
    // Release the connection so a logout's deleteDatabase isn't blocked.
    close: () => db.close(),
    kvGet: (key) =>
      new Promise((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    kvPut: (key, value) => tx(db, 'kv', 'readwrite', (s) => s.put(value, key)),
    serverPut: (record) => tx(db, 'servers', 'readwrite', (s) => s.put(record)),
    serverDelete: (id) => tx(db, 'servers', 'readwrite', (s) => s.delete(id)),
    /** Purge every message of a circle (leave/kick/delete). The store is
        keyed by autoIncrement with only a [server, channel] index, so walk
        that index across the circle's channels via a bound cursor. */
    msgsDeleteServer: (server) =>
      new Promise((resolve, reject) => {
        const store = db.transaction('messages', 'readwrite').objectStore('messages');
        // A key range over [server, -∞] .. [server, +∞] catches every channel.
        const range = IDBKeyRange.bound([server, -Infinity], [server, [] ]);
        const req = store.index('byChannel').openCursor(range);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          cur.delete();
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      }),
    serversAll: () =>
      new Promise((resolve, reject) => {
        const req = db.transaction('servers').objectStore('servers').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    msgAdd: (message) => tx(db, 'messages', 'readwrite', (s) => s.add(message)),
    /** Patch one message identified by (sender, ts) — reactions live on the
        stored message, so late readers see them too. */
    msgPatch: (server, channel, sender, ts, patch) =>
      new Promise((resolve, reject) => {
        const store = db.transaction('messages', 'readwrite').objectStore('messages');
        const req = store.index('byChannel').openCursor([server, channel]);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(false);
          const v = cur.value;
          if (!v.system && v.sender === sender && v.ts === ts) {
            cur.update(patch(v));
            return resolve(true);
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      }),
    msgsFor: (server, channel) =>
      new Promise((resolve, reject) => {
        const req = db
          .transaction('messages')
          .objectStore('messages')
          .index('byChannel')
          .getAll([server, channel]);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    /** Delete a channel's messages older than `beforeTs` (auto-delete). */
    msgsPrune: (server, channel, beforeTs) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('messages', 'readwrite');
        const req = t.objectStore('messages').index('byChannel').openCursor([server, channel]);
        let removed = 0;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value.ts < beforeTs) {
            cursor.delete();
            removed += 1;
          }
          cursor.continue();
        };
        t.oncomplete = () => resolve(removed);
        t.onerror = () => reject(t.error);
      }),
    // Move a channel's history to a new name (channel rename). Fetch the
    // primary keys first, then get/put by key — safer than mutating an
    // indexed field mid-cursor.
    msgsRename: (server, from, to) =>
      new Promise((resolve, reject) => {
        const store = db.transaction('messages', 'readwrite').objectStore('messages');
        const keysReq = store.index('byChannel').getAllKeys([server, from]);
        keysReq.onsuccess = () => {
          const keys = keysReq.result;
          let i = 0;
          const next = () => {
            if (i >= keys.length) return resolve();
            const k = keys[i++];
            const g = store.get(k);
            g.onsuccess = () => {
              const v = g.result;
              if (v) {
                v.channel = to;
                store.put(v, k);
              }
              next();
            };
            g.onerror = () => reject(g.error);
          };
          next();
        };
        keysReq.onerror = () => reject(keysReq.error);
      }),
    // Purge a channel's history (channel delete).
    msgsDelete: (server, channel) =>
      new Promise((resolve, reject) => {
        const store = db.transaction('messages', 'readwrite').objectStore('messages');
        const req = store.index('byChannel').openCursor([server, channel]);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          cur.delete();
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      }),
  };
}
