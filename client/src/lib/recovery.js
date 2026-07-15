// Recovery key: the identity bundle passphrase-wrapped with WebCrypto.
// PBKDF2-SHA256 (310k iterations) -> AES-256-GCM. The code is generated,
// not user-chosen — no weak passphrases.
//
// Scope, honestly: this protects the *identity key* (the thing the relay
// has pinned — losing it means losing the account name forever). It does
// not resurrect group ratchet state; after a restore you keep your
// identity and get re-added to groups.

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no lookalikes

export function generateCode() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(raw, (byte) => ALPHABET[byte % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars
    .slice(8, 12)
    .join('')}-${chars.slice(12, 16).join('')}`;
}

async function deriveKey(code, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(code.replaceAll('-', '').toUpperCase()),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** identity bytes + code -> downloadable file bytes */
export async function wrapIdentity(identity, code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(code, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, identity);
  const file = { v: 1, kdf: 'PBKDF2-SHA256-310k', salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
  return new TextEncoder().encode(JSON.stringify(file));
}

/** file bytes + code -> identity bytes (throws on wrong code/corrupt file) */
export async function unwrapIdentity(fileBytes, code) {
  const file = JSON.parse(new TextDecoder().decode(fileBytes));
  if (file.v !== 1) throw new Error('unsupported recovery file version');
  const key = await deriveKey(code, fromB64(file.salt));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(file.iv) },
    key,
    fromB64(file.ct)
  );
  return new Uint8Array(pt);
}
