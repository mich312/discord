// What the encryption line under a conversation says. Pure, so it is tested
// without a DOM; EncryptionNote.jsx renders whatever this returns.

/** Others in the circle whose safety number nobody has compared on this
    device. Mismatched members are not here: they were compared and did not
    match, which is worse, and mismatchedMembers() reports them. */
export function uncheckedMembers(server, me) {
  const verified = server.verified ?? [];
  return (server.members ?? []).filter(
    (m) => m !== me && !verified.includes(m) && !server.mismatched?.[m]
  );
}

/** Current members whose safety number did not match when compared. */
export function mismatchedMembers(server, me) {
  return (server.members ?? []).filter((m) => m !== me && Boolean(server.mismatched?.[m]));
}

const people = (n, what = '') =>
  `${n} ${what}${n === 1 ? 'person' : 'people'}`;

/**
 * The line's state and words.
 *   mismatch    a compared key did not match. Outranks every other state, so
 *               a mismatch can never read as verified.
 *   unverified  someone's key has not been compared yet
 *   verified    every other member's key has been compared
 *   alone       nobody else is in the circle
 * `text` is the sentence; `action`, when set, is the link to the fix.
 */
export function encryptionNote(server, me) {
  const members = server.members ?? [];
  const mismatched = mismatchedMembers(server, me);
  if (mismatched.length) {
    return {
      state: 'mismatch',
      text:
        mismatched.length === 1
          ? `${mismatched[0]}’s key doesn’t match`
          : `${mismatched.length} keys don’t match`,
      action: 'Review',
      who: mismatched,
    };
  }
  if (!members.some((m) => m !== me)) {
    return { state: 'alone', text: 'Only you are here', action: null, who: [] };
  }
  const unchecked = uncheckedMembers(server, me);
  if (unchecked.length) {
    return {
      state: 'unverified',
      text: `Encrypted for ${people(members.length)}`,
      action: `${unchecked.length} not verified`,
      who: unchecked,
    };
  }
  return {
    state: 'verified',
    text: `Encrypted for ${people(members.length, 'verified ')}`,
    action: null,
    who: [],
  };
}
