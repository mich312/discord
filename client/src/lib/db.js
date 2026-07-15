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
    kvGet: (key) =>
      new Promise((resolve, reject) => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    kvPut: (key, value) => tx(db, 'kv', 'readwrite', (s) => s.put(value, key)),
    serverPut: (record) => tx(db, 'servers', 'readwrite', (s) => s.put(record)),
    serversAll: () =>
      new Promise((resolve, reject) => {
        const req = db.transaction('servers').objectStore('servers').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    msgAdd: (message) => tx(db, 'messages', 'readwrite', (s) => s.add(message)),
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
  };
}
