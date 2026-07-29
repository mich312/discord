// Channel log crypto. Every channel has a random AES key (hkey) and an
// opaque log id (hid). The key travels ONLY inside the group's MLS
// messages — sharing it with whoever is in the roster is the point: it is
// what lets a joiner, or your own next device, read a channel that existed
// before their ratchets did. The relay stores the log as ciphertext under
// an id it cannot map to a channel.
//
// The room key is what makes the log *readable* by the roster. It is
// deliberately not what makes an entry *authentic*: anyone holding it can
// write a well-formed entry claiming any sender. So each entry also
// carries an Ed25519 signature by its author's MLS identity key — the same
// key that signs their MLS messages and that safety numbers are computed
// from. A reader checks it against the circle's key directory (see
// `keys.js`) and treats an entry it cannot attribute as unsigned rather
// than as authored.
//
// The honest cost, stated once here and again in the UI: keeping a
// long-lived key around trades forward secrecy for that channel's content.
// Retention (auto-delete) bounds how much a leaked key ever unlocks.
import { b64 } from './relay.js';
import { b64url, decryptBlob, encryptBlob } from './invite.js';

/** Wire version of a sealed log entry. Entries without one predate
    signatures and are read, but never trusted for authorship. */
export const LOG_ENTRY_VERSION = 1;

const SIGNING_CONTEXT = 'quorum-log-entry-v1';
/** Field separator inside the signed bytes. NUL cannot occur in a circle
    id, a log id, or JSON, so no field can be made to look like another. */
const FIELD_SEP = '\u0000';

export function generateHistoryId() {
  return b64url.enc(crypto.getRandomValues(new Uint8Array(12)));
}

export function generateHistoryKey() {
  return b64.enc(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * A signature is over bytes, so both ends must agree on exactly which
 * bytes. `JSON.stringify` preserves insertion order, which means the same
 * entry built by two clients — or by the same client across a refactor —
 * can serialize differently and fail to verify. Sorting removes that as a
 * source of false "forged entry" verdicts.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * The exact bytes an entry's author signs.
 *
 * `group` and `hid` are bound in even though they are not stored in the
 * entry: they are the entry's *location*, and without them a valid entry
 * could be lifted out of one channel's log and replayed into another's by
 * anyone who holds both room keys. Everything else is the entry itself,
 * minus the signature — so no field can be added, dropped or reworded
 * after the fact.
 */
export function entrySigningBytes(group, hid, entry) {
  const { sig: _sig, ...signed } = entry;
  return new TextEncoder().encode(
    [SIGNING_CONTEXT, group, hid, canonicalJson(signed)].join(FIELD_SEP)
  );
}

/**
 * Seal one entry for the relay's log.
 *
 * `sign` is injected (it lives in the crypto worker) and returns the raw
 * signature bytes over whatever it is handed.
 */
export async function sealLogEntry(hkeyB64, group, hid, entry, sign) {
  const body = { v: LOG_ENTRY_VERSION, ...entry };
  const sig = await sign(entrySigningBytes(group, hid, body));
  const sealed = { ...body, sig: b64.enc(sig) };
  const data = new TextEncoder().encode(JSON.stringify(sealed));
  return b64.enc(await encryptBlob(b64.dec(hkeyB64), data));
}

/** Decrypt one entry. Says nothing about who wrote it — see `verifyEntry`. */
export async function openLogEntry(hkeyB64, payloadB64) {
  const plain = await decryptBlob(b64.dec(hkeyB64), b64.dec(payloadB64));
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * What an entry's signature is worth, given a key directory.
 *
 *   'signed'   — checked against the key the roster holds for that sender
 *   'unsigned' — no signature at all (written before signatures existed)
 *   'unknown'  — signed, but we hold no key for that sender, so the claim
 *                is unchecked rather than wrong
 *   'forged'   — a signature that does not verify. The caller drops these.
 *
 * `verifyBatch(items) -> bool[]` is injected because verification lives in
 * the worker; this function only decides what to ask and how to read the
 * answers.
 */
export async function verifyEntries(group, hid, entries, keys, verifyBatch) {
  const checks = [];
  const verdicts = entries.map((entry) => {
    if (!entry || typeof entry.sig !== 'string') return 'unsigned';
    const key = keys?.[entry.sender];
    if (!key) return 'unknown';
    checks.push({
      key: b64.dec(key),
      message: entrySigningBytes(group, hid, entry),
      sig: b64.dec(entry.sig),
    });
    return 'pending';
  });
  if (!checks.length) return verdicts;
  const results = await verifyBatch(checks);
  let i = 0;
  return verdicts.map((v) => (v === 'pending' ? (results[i++] ? 'signed' : 'forged') : v));
}

/** Content identity of a message, for deduplicating a log backfill against
    messages this device already received live over MLS. */
export function messageFingerprint(m) {
  const body = m.file ? `f:${m.file.blob}` : m.game ? `g:${m.game.id}` : `t:${m.text ?? ''}`;
  return `${m.sender}|${m.ts}|${body}`;
}

/** The circles-backup key: derived deterministically from the identity
    bundle, which is byte-identical on every signed-in device (the vault
    round-trips it verbatim). The relay never sees the identity bytes, so
    it can never derive this key. */
export async function deriveBackupKey(identityBytes) {
  const context = new TextEncoder().encode('quorum-circles-backup-v1');
  const material = new Uint8Array(context.length + identityBytes.length);
  material.set(context);
  material.set(identityBytes, context.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', material));
}

/** Encrypt/decrypt the circles backup blob (group records + channel keys). */
export async function sealBackup(identityBytes, record) {
  const key = await deriveBackupKey(identityBytes);
  const data = new TextEncoder().encode(JSON.stringify(record));
  return b64.enc(await encryptBlob(key, data));
}

export async function openBackup(identityBytes, payloadB64) {
  const key = await deriveBackupKey(identityBytes);
  const plain = await decryptBlob(key, b64.dec(payloadB64));
  return JSON.parse(new TextDecoder().decode(plain));
}
