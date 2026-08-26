// Where a circle's state lives, now that the relay holds it.
//
// An in-memory circle record is one object, but its fields do not all
// belong in one place, and pretending they did is what let a device's
// private copy drift from the account's. Three groups, and the rule for
// each is the same question: *could a second device of mine legitimately
// disagree about this?*
//
//   shared  — no. A circle's name, its rooms, their settings, the room
//             keys that open them, the key directory, the home base. Every
//             device of every member should see the same answer, so this
//             rides the encrypted backup blob on the relay and is loaded
//             from there at boot.
//
//   device  — yes, and it must. Where this device's subscription got to
//             (`lastSeq`, `epoch`), what it has caught up on (`seen`), and
//             the safety numbers its user compared face to face
//             (`verifiedSn`, `mismatched`). Verification especially: it is
//             a judgement about a comparison that was made in one room, on
//             one device, and it does not transfer to a device that never
//             made it. Kept in IndexedDB, never uploaded.
//
//   derived — neither. `members` and `roles` are re-read from the MLS
//             roster and the relay's ACL on every connect, so storing them
//             only creates something to go stale. The fork verdict and the
//             sync flags are re-earned from live traffic by design.
//
// The room keys sit in `shared` — which means they are on the relay. That
// is not a weakening: the blob is sealed client-side under a key derived
// from the identity bundle, so the relay holds the keys to the messages it
// already holds and can read neither. It is what lets a new sign-in open a
// room the old device is no longer awake for.

/** Fields that ride the encrypted backup — the circle as the account sees it. */
export const SHARED_FIELDS = [
  'id',
  'name',
  'channels',
  'voiceChannels',
  'chanMeta',
  'keys',
  'overview',
  'notices',
  'offers',
  'rsvps',
  // Invite fragment keys. They have to travel with the circle now: the
  // parked GroupInfo blob goes stale every epoch and the creator's client
  // is what re-encrypts it, so a device that cannot recover the fragment
  // key silently stops refreshing a link that still looks live.
  'invites',
  // Deletion tombstones. Without these the meta union — which is ungated
  // on purpose, so it can heal a device that dropped a `chan` event —
  // resurrects a room somebody deliberately deleted, on every boot.
  'deletedChannels',
  'deletedVoice',
];

/** Fields kept on this device only, keyed by circle id under `deviceState`. */
export const DEVICE_FIELDS = [
  'lastSeq',
  'epoch',
  'seen',
  'verified',
  'verifiedSn',
  'mismatched',
  'joinedAt',
];

const pick = (source, fields) => {
  const out = {};
  for (const f of fields) if (source?.[f] !== undefined) out[f] = source[f];
  return out;
};

/** The half of `record` that belongs in the backup blob. */
export function sharedHalf(record) {
  return {
    ...pick(record, SHARED_FIELDS),
    // Defaults are applied here rather than at every call site, so a blob
    // written by any device has the same shape.
    channels: record.channels?.length ? [...record.channels] : ['general'],
    voiceChannels: [...(record.voiceChannels ?? ['lounge'])],
    chanMeta: record.chanMeta ?? {},
    keys: record.keys ?? {},
    notices: record.notices ?? [],
    rsvps: record.rsvps ?? {},
    invites: record.invites ?? [],
    overview: record.overview ?? null,
  };
}

/** The half of `record` that stays on this device. */
export function deviceHalf(record) {
  return {
    ...pick(record, DEVICE_FIELDS),
    lastSeq: record.lastSeq ?? 0,
    epoch: record.epoch ?? 0,
  };
}

/**
 * Rebuild an in-memory record from the two halves.
 *
 * `device` is missing for a circle this device has never opened — a fresh
 * sign-in, or one joined on another device. Then there is no cursor, and
 * `joinedAt` is set to now so the unread count starts from when this device
 * learned about the circle rather than counting its whole past as missed.
 *
 * `live` — whether this device can *send* — is passed in rather than read
 * from either half, because the only truthful answer is whether the MLS
 * client holds a ratchet for the group, and neither half knows that. It was
 * briefly stored as device state, which was wrong in the way that matters:
 * a stored flag is absent for every install that predates it, so every
 * existing device read as read-only the moment this store was introduced,
 * with a perfectly good ratchet sitting in IndexedDB beside it. Derived
 * from the ratchet, the question cannot be answered wrongly by a
 * migration.
 */
export function hydrate(shared, device, { now = Date.now(), live = false } = {}) {
  return {
    ...sharedHalf(shared),
    id: shared.id,
    name: shared.name ?? shared.id,
    lastSeq: device?.lastSeq ?? 0,
    epoch: device?.epoch ?? 0,
    seen: device?.seen ?? {},
    verified: device?.verified ?? [],
    verifiedSn: device?.verifiedSn ?? {},
    mismatched: device?.mismatched ?? {},
    joinedAt: device?.joinedAt ?? now,
    // Derived, never stored: re-read from the roster and the ACL on connect.
    members: [],
    roles: {},
    ...(live ? {} : { restored: true }),
  };
}

/**
 * Fold a backup we just read over the circles we are holding.
 *
 * Called when a write loses the compare-and-swap: another device of this
 * account parked a newer blob between our read and our write. Neither side
 * is simply right.
 *
 * - A circle only *they* have is one they joined while we were away. Take
 *   it: dropping it is how a device silently loses a circle.
 * - A circle we both have, we keep. Our copy is the one carrying the edit
 *   that triggered this write, and their copy is by definition older than
 *   that edit.
 * - A circle only *we* have is either one we just joined or one they just
 *   left. Keep it and let the leave, if that is what it was, be re-applied
 *   from their next write — the alternative silently undoes a join, and a
 *   circle that reappears is a visible, fixable annoyance where one that
 *   vanishes is not.
 *
 * Last-writer-wins per circle, in other words, but never per blob. The
 * whole-blob overwrite is the failure this exists to prevent.
 */
export function mergeBackups(mine, theirs) {
  const byId = new Map();
  for (const circle of theirs ?? []) if (circle?.id) byId.set(circle.id, circle);
  for (const circle of mine ?? []) if (circle?.id) byId.set(circle.id, circle);
  return [...byId.values()];
}
