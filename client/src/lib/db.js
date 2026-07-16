// IndexedDB, promisified, three stores:
//   kv       — mls state snapshot, session record
//   servers  — {id, name, channels[], members[], epoch, lastSeq}
//   messages — {server, channel, sender, text, ts, system?, reactions?},
//              indexed by channel; reactions is {emoji: [handles]}
import { messageFingerprint } from './history.js';

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
    /** Toggle `user` on/off a message's reaction set. The message is
        addressed by content fingerprint (sender|ts|payload) — the same
        identity used to dedupe history backfill — so every device edits
        the same message regardless of local insertion order. Returns
        true if a message matched. */
    msgReact: (server, channel, fp, emoji, user, op) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('messages', 'readwrite');
        const req = t.objectStore('messages').index('byChannel').openCursor([server, channel]);
        let found = false;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || found) return;
          const m = cursor.value;
          if (!m.system && messageFingerprint(m) === fp) {
            found = true;
            const reactions = { ...(m.reactions ?? {}) };
            const users = new Set(reactions[emoji] ?? []);
            if (op === 'add') users.add(user);
            else users.delete(user);
            if (users.size) reactions[emoji] = [...users];
            else delete reactions[emoji];
            cursor.update({ ...m, reactions });
            return;
          }
          cursor.continue();
        };
        t.oncomplete = () => resolve(found);
        t.onerror = () => reject(t.error);
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
  };
}
