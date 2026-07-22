// Device linking: hand your identity from a signed-in device to a fresh one
// without a password, a file, or a matching passkey PRF.
//
// The new device mints an ephemeral P-256 keypair and shows a QR/link that
// carries its PUBLIC key in the URL *fragment* (browsers never send fragments
// to the server) plus a random rendezvous id. The signed-in device seals the
// identity to that public key (ECDH → HKDF → AES-GCM) and PUTs the ciphertext
// to the rendezvous blob; the new device polls, opens it with its private key,
// and adopts the identity. The relay only ever holds an opaque sealed blob
// under an unguessable id — it never sees the key or the identity.
//
// Confidential but unauthenticated: anyone who sees the QR could seal *their*
// identity to it, so the receiving device shows the handle it got and asks the
// user to confirm, and the sender confirms before handing its identity over.

import { b64url } from './invite.js';

const INFO = new TextEncoder().encode('quorum/device-link/v1');
// A raw P-256 public key is 65 bytes (0x04 ‖ X ‖ Y); AES-GCM IV is 12.
const PUB_LEN = 65;
const IV_LEN = 12;

function genEphemeral() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

async function exportPub(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

function importPub(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** The shared AES-GCM key both sides reach: ECDH is symmetric, so
    ECDH(mine, theirsPub) == ECDH(theirs, minePub). */
async function sharedKey(privateKey, peerPubRaw) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importPub(peerPubRaw) },
    privateKey,
    256
  );
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** A 6-digit check code from the offer's public key. Both devices derive it
    from the same bytes; a match confirms the phone scanned this screen's QR
    (not a tampered one). It is a UX check, not the security boundary. */
export async function verifyCode(pubRaw) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', pubRaw));
  const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000;
  return String(n).padStart(6, '0');
}

/** New device: create a linking offer. Keep `privateKey` and `blobId` in
    memory; render `url` as a QR (and show it as a copyable link + `code`). */
export async function createLinkOffer(origin) {
  const kp = await genEphemeral();
  const pub = await exportPub(kp.publicKey);
  const blobId = b64url.enc(crypto.getRandomValues(new Uint8Array(18)));
  const url = `${origin}/?link=${blobId}#k=${b64url.enc(pub)}`;
  return { url, blobId, privateKey: kp.privateKey, pub, code: await verifyCode(pub) };
}

/** Signed-in device: parse a link URL it was opened with. Null if absent —
    lets the app tell a link (?link=) from an invite (?j=). */
export function parseLinkUrl(loc) {
  const blobId = new URLSearchParams(loc.search).get('link');
  const match = loc.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (!blobId || !match) return null;
  return { blobId, pub: b64url.dec(match[1]) };
}

/** Signed-in device: seal `identity` to the offer's public key. Returns the
    bytes to PUT to the rendezvous and the check code to display. */
export async function sealIdentity(pubRaw, identity) {
  const eph = await genEphemeral();
  const ephPub = await exportPub(eph.publicKey);
  const key = await sharedKey(eph.privateKey, pubRaw);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, identity));
  const out = new Uint8Array(ephPub.length + iv.length + ct.length);
  out.set(ephPub, 0);
  out.set(iv, ephPub.length);
  out.set(ct, ephPub.length + iv.length);
  return { payload: out, code: await verifyCode(pubRaw) };
}

/** New device: open a sealed payload with the offer's private key -> identity
    bytes. Throws on a corrupt/foreign payload (AES-GCM auth failure). */
export async function openSealed(privateKey, payload) {
  if (payload.length < PUB_LEN + IV_LEN) throw new Error('link payload too short');
  const ephPub = payload.slice(0, PUB_LEN);
  const iv = payload.slice(PUB_LEN, PUB_LEN + IV_LEN);
  const ct = payload.slice(PUB_LEN + IV_LEN);
  const key = await sharedKey(privateKey, ephPub);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
