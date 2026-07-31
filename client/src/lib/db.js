// IndexedDB, promisified. One store:
//   kv — mlsState (the MLS ratchet snapshot), session, securedLocal, and
//        deviceState (this device's cursors and its own judgements)
//
// What is deliberately NOT here: messages, and now the circles themselves.
//
// Version 1 kept every decrypted message in a `messages` store, because the
// device that received a line was the only place it existed. The relay now
// holds the conversation — each channel's log, sealed under a room key the
// whole roster has — so a local copy would be a second, diverging one that
// a fresh device could not have anyway. Version 2 deleted that store, and
// deleted it on upgrade rather than leaving it: plaintext nobody reads is
// still plaintext on a device someone can take.
//
// Version 3 finishes the same argument one level up. A circle's shape —
// its name, its channels, their settings, the room keys that open them —
// was still being kept here as well as parked on the relay, and the two
// copies could disagree: whichever device last wrote the backup decided
// what a *new* device saw, while this one kept believing its own store.
// The relay's blob is now the only copy, so every device that can sign in
// reconstructs the same circles from the same bytes.
//
// What stays is what genuinely cannot live on the relay:
//
//   mlsState     the ratchet. Not backed up by design — that is what makes
//                a restored device read-only until someone re-adds it.
//   deviceState  per-circle cursors (`lastSeq`, `epoch`), what this device
//                has caught up on (`seen`), and the safety numbers its user
//                compared in person (`verifiedSn`, `mismatched`). None of
//                it is account data: a second device has legitimately seen
//                different things and verified different people.
//
// The room keys moved out with the rest of the shape. They are in the
// backup blob, which is sealed client-side under a key derived from the
// identity — so the relay holds them and still cannot read them, exactly
// as it holds the messages they open.
const DB_NAME = 'e2ee-client';
const DB_VERSION = 3;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      // Upgrading from v1: drop the message archive and everything in it.
      if (event.oldVersion < 2 && db.objectStoreNames.contains('messages')) {
        db.deleteObjectStore('messages');
      }
      // Upgrading from v2: drop the local circle records. Deleted rather
      // than migrated on purpose — the same circles are already in the
      // parked backup, and the records left here carry room keys, which is
      // the one thing worth not leaving on a device that no longer reads
      // them. The cursors they also carried are cheap to lose: `lastSeq`
      // re-derives from a full re-subscribe, and an unread badge that
      // over-counts once is a smaller cost than a stale key store.
      if (event.oldVersion < 3 && db.objectStoreNames.contains('servers')) {
        db.deleteObjectStore('servers');
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
  };
}
