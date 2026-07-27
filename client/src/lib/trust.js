// Per-peer trust state, as pure transitions over a server record.
//
// These live here rather than inline in the controller so they can be
// asserted directly: they decide whether a member renders as verified, as a
// key mismatch, or as neither, and getting that wrong is a security bug
// rather than a display one. The controller owns persistence and dispatch;
// these own the rules.
//
// Two states, never both. `verifiedSn` maps peer -> the safety number the
// user compared and accepted; `mismatched` maps peer -> the number they
// compared and rejected. Both are keyed on the number rather than the handle,
// so a later key change can retire either one.
//
// Both are device-local and deliberately outside the encrypted backup: they
// record a comparison this user made in person, which does not transfer to a
// device that never made it.

/** Record that a comparison matched. Clears any standing mismatch — they
    compared again, and this time it was right. */
export function applyVerified(record, peer, sn) {
  record.verifiedSn = { ...(record.verifiedSn ?? {}), [peer]: sn };
  record.verified = Object.keys(record.verifiedSn);
  if (record.mismatched?.[peer]) {
    const { [peer]: _gone, ...rest } = record.mismatched;
    record.mismatched = rest;
  }
  return record;
}

/** Record that a comparison came back wrong. Retracts any standing
    verification: the two claims cannot both be live, and the unsafe one must
    not win by being older. */
export function applyMismatch(record, peer, sn) {
  record.mismatched = { ...(record.mismatched ?? {}), [peer]: sn };
  if (record.verifiedSn?.[peer]) {
    const { [peer]: _gone, ...rest } = record.verifiedSn;
    record.verifiedSn = rest;
    record.verified = Object.keys(rest);
  }
  return record;
}

/** Drop a mismatch whose key is gone. The finding was about the key that was
    in front of the user when they compared; once that key changes the warning
    is spent, and clearing it must never read as trust. Returns true if
    anything changed. */
export function retireMismatch(record, peer, currentSn) {
  if (!record.mismatched?.[peer]) return false;
  if (record.mismatched[peer] === currentSn) return false;
  delete record.mismatched[peer];
  return true;
}
