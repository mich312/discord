// Channel history crypto. A channel with "history" enabled gets a random
// AES key (hkey) and an opaque log id (hid). The key travels ONLY inside
// the group's MLS messages — sharing it with whoever is in the roster is
// the point: it is what lets a joiner (or your own next device) read back
// messages sent before their MLS ratchets existed. The relay stores the
// log as ciphertext under an id it cannot map to a channel.
//
// The honest cost, stated once here and again in the UI: history entries
// are authenticated by the channel key, not by per-message signatures, and
// keeping a long-lived key around deliberately trades forward secrecy for
// that channel's content. Retention (auto-delete) bounds the exposure.
import { b64 } from './relay.js';
import { b64url, decryptBlob, encryptBlob } from './invite.js';

export function generateHistoryId() {
  return b64url.enc(crypto.getRandomValues(new Uint8Array(12)));
}

export function generateHistoryKey() {
  return b64.enc(crypto.getRandomValues(new Uint8Array(32)));
}

/** {sender, text?|file?, ts} -> base64 AES-GCM blob for the relay log. */
export async function sealHistoryEntry(hkeyB64, entry) {
  const data = new TextEncoder().encode(JSON.stringify(entry));
  return b64.enc(await encryptBlob(b64.dec(hkeyB64), data));
}

export async function openHistoryEntry(hkeyB64, payloadB64) {
  const plain = await decryptBlob(b64.dec(hkeyB64), b64.dec(payloadB64));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Content identity of a message, for deduplicating a history backfill
    against messages this device already received live over MLS. */
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
