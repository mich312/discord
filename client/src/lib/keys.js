// The per-circle key directory: which Ed25519 identity key speaks for which
// handle.
//
// Why it exists. A channel's log entries are signed by their author, and a
// reader has to look that author's key up somewhere. The relay knows every
// handle's pinned key, but taking it from there would mean a hostile relay
// could hand out its own key and sign entries as anybody — the log would be
// authenticated by the relay's word, which is the one thing this design
// refuses to rely on.
//
// So the directory is built from the MLS roster instead: the ratchet tree is
// the cryptographic answer to who is in the circle and what key they hold.
// It is kept on the circle's record, which means it rides the encrypted
// circles backup — so a device restored from a backup can still check the
// signature on an entry written by someone who has since gone offline, or
// left, without asking the relay to vouch for anybody.
//
// What it is still not: proof of identity. A key learned from a roster the
// relay helped assemble is trust-on-first-contact, exactly as §6.1 of the
// threat model says. Comparing a safety number is what upgrades it.

import { b64 } from './relay.js';

/**
 * Fold an MLS roster into a circle's key directory.
 *
 * @param record   the circle record; `record.keys` is created if absent
 * @param roster   `{handle: Uint8Array}` from the crypto worker
 * @returns `{changed, conflicts}` — `conflicts` names handles whose key is
 *          not the one we already had. That is either a key rotation (which
 *          this build does not do) or substitution, so it is surfaced rather
 *          than absorbed: the roster wins, and entries signed by the old key
 *          stop verifying, which is the safe direction to fail.
 */
export function mergeKeyDirectory(record, roster) {
  const keys = { ...(record.keys ?? {}) };
  const conflicts = [];
  let changed = false;
  for (const [handle, raw] of Object.entries(roster ?? {})) {
    if (!handle || !raw?.length) continue;
    const encoded = b64.enc(raw);
    if (keys[handle] === encoded) continue;
    if (keys[handle]) conflicts.push(handle);
    keys[handle] = encoded;
    changed = true;
  }
  if (changed) record.keys = keys;
  return { changed, conflicts };
}

/** The directory as the verifier wants it: `{handle: base64 key}`. Missing
    is a legitimate answer — a member who left before this device ever saw
    the roster is unattributable, not forged. */
export function keyDirectory(record) {
  return record?.keys ?? {};
}
