// IndexedDB, promisified. Two stores:
//   kv       — mls state snapshot, session record
//   servers  — {id, name, channels[], members[], chanMeta{}, keys{}, epoch,
//              lastSeq}
//
// What is deliberately NOT here any more: messages.
//
// Version 1 kept every decrypted message in a `messages` store, because the
// device that received a line was the only place it existed. The relay now
// holds the conversation — each channel's log, sealed under a room key the
// whole roster has — so a local copy would be a second, diverging one that
// a fresh device could not have anyway. Version 2 deletes that store, and
// deletes it on upgrade rather than leaving it: plaintext nobody reads is
// still plaintext on a device someone can take.
//
// What stays is key material and the shape it unlocks — circle names,
// channel settings, room keys, the MLS ratchet, the key directory. That is
// the deliberate line: this device holds keys, not content.
const DB_NAME = 'e2ee-client';
const DB_VERSION = 2;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('servers')) {
        db.createObjectStore('servers', { keyPath: 'id' });
      }
      // Upgrading from v1: drop the message archive and everything in it.
      if (event.oldVersion < 2 && db.objectStoreNames.contains('messages')) {
        db.deleteObjectStore('messages');
      }
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
    serversAll: () =>
      new Promise((resolve, reject) => {
        const req = db.transaction('servers').objectStore('servers').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  };
}
