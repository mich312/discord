// Invite-link crypto. The GroupInfo blob is AES-GCM-encrypted under a
// random key that travels ONLY in the URL fragment — browsers never send
// fragments over the network, so the relay stores a blob it cannot read.

export const b64url = {
  enc: (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, ''),
  dec: (s) =>
    Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
};

export function generateInviteId() {
  return b64url.enc(crypto.getRandomValues(new Uint8Array(6)));
}

export function generateFragmentKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importKey(raw, usage) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

/** -> iv || ciphertext */
export async function encryptBlob(rawKey, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(rawKey, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

export async function decryptBlob(rawKey, bytes) {
  const iv = bytes.slice(0, 12);
  const key = await importKey(rawKey, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(12)));
}

/** Parse ?j=<id>#k=<key> from a location; null if absent/malformed. */
export function parseInviteUrl(loc) {
  const id = new URLSearchParams(loc.search).get('j');
  const match = loc.hash.match(/k=([A-Za-z0-9_-]+)/);
  if (!id || !match) return null;
  return { id, key: match[1] };
}

export function buildInviteUrl(loc, id, rawKey) {
  const params = new URLSearchParams();
  // Non-default relay (dev/test sessions) must survive into the link.
  const relay = new URLSearchParams(loc.search).get('relay');
  if (relay) params.set('relay', relay);
  params.set('j', id);
  return `${loc.origin}${loc.pathname}?${params}#k=${b64url.enc(rawKey)}`;
}
