// Fork detection — §1.1's fourth part, the one that was never built.
//
// §1.1 stopped NEW forks: commits are staged until the relay's epoch CAS
// accepts them, so two admins can no longer both merge at epoch 6. It did
// nothing for groups that forked BEFORE that landed, and nothing for a local
// MLS state that diverges for some other reason (a restore from a stale
// backup, a corrupted snapshot). Those circles are permanently broken, and
// the only symptom is `console.warn('undecryptable blob seq N')` — a line
// whose own comment says it is expected.
//
// That comment is right, which is the whole difficulty: undecryptable blobs
// are NORMAL. This module exists to separate the normal ones from the shape
// that means "this device is on a branch nobody else is on".
//
// Three failures are expected and must never count:
//
//   * our own commits, replayed to us by catch-up;
//   * blobs stamped with an epoch ahead of ours — we simply have not applied
//     that commit yet, and will;
//   * everything in a restored read-only stub, which holds no MLS state at
//     all and therefore decrypts nothing by design.
//
// What is left — a message from someone else, at an epoch we believe we have
// already reached, that will not open — is the fork's actual signature. In a
// real fork EVERY message from the other branch fails, forever, so the
// evidence accumulates rather than flickering.
//
// Counting is per sender, and that matters. Consider alice and bob on one
// branch with carol on another: carol sees both of them fail and detects it
// quickly, while alice sees bob succeed between every carol failure. A single
// group-wide counter would reset on bob and alice would never notice. Per
// sender, alice learns something true and useful — "carol's messages cannot
// be read" — which is a different fact from "I am cut off", and this module
// reports them separately.
//
// The asymmetry is the right way round: the device that is cut off is the one
// that has to act, and it is the one that detects fastest.
//
// No persistence. A restart re-derives the verdict from live traffic, which
// is a feature — a stale "this circle is broken" flag surviving a fix would
// be worse than re-earning it over the next few messages.

/** Consecutive unexplained failures from one sender before we believe it.
    Deliberately conservative: telling a healthy circle it is broken is worse
    than taking a few more messages to notice a real fork, and a real fork
    never heals on its own, so there is no cost to waiting. */
export const FORK_THRESHOLD = 5;

/**
 * Why did this blob fail to open?
 *
 * @returns `'self'` | `'ahead'` | `'restored'` — expected, carries no signal.
 *          `'suspect'` — the fork signature.
 */
export function classifyFailure({ sender, epoch, me, groupEpoch, restored = false } = {}) {
  if (restored) return 'restored';
  if (sender === me) return 'self';
  // `> groupEpoch` and not `>=`: a blob from an epoch we have not applied yet
  // is a message we are simply behind on. One stamped with the epoch we are
  // already at should open, and its failing is the thing worth counting.
  if (Number.isFinite(epoch) && Number.isFinite(groupEpoch) && epoch > groupEpoch) return 'ahead';
  return 'suspect';
}

/**
 * Per-group, per-sender tally of unexplained decrypt failures.
 *
 * Lives in memory on the controller. `succeeded` is the important half: one
 * message that opens from a given sender proves the ratchet is still shared
 * with them, so their evidence is discarded outright rather than decayed.
 */
export class ForkWatch {
  constructor({ threshold = FORK_THRESHOLD } = {}) {
    this.threshold = threshold;
    /** group -> { counts: Map(sender -> consecutive suspect failures),
                   seen: Set(senders we have reached a conclusion about) } */
    this.groups = new Map();
  }

  #state(group) {
    let s = this.groups.get(group);
    if (!s) {
      s = { counts: new Map(), seen: new Set() };
      this.groups.set(group, s);
    }
    return s;
  }

  /** A blob from `sender` opened. Whatever we suspected about them is wrong. */
  succeeded(group, sender) {
    const s = this.#state(group);
    s.counts.delete(sender);
    // Tracked separately from `counts`, because `outOfSync` asks whether
    // EVERY sender we can judge is unreadable — and a sender who has only
    // ever succeeded has no count. Deriving the denominator from `counts`
    // alone made one bad sender among several good ones look like "nobody
    // can reach us", which is the opposite conclusion and the wrong remedy.
    s.seen.add(sender);
  }

  /**
   * A blob failed to open. Returns the reason it was classified as, so the
   * caller can log something more useful than "undecryptable".
   */
  failed(group, info) {
    const why = classifyFailure(info);
    if (why === 'suspect') {
      const s = this.#state(group);
      s.counts.set(info.sender, (s.counts.get(info.sender) ?? 0) + 1);
      s.seen.add(info.sender);
    }
    // 'ahead' deliberately does not mark the sender as seen: it is a
    // transient state we expect to resolve, so it should neither convict
    // them nor count towards the denominator that convicts us.
    return why;
  }

  /**
   * What do we believe about this group?
   *
   * `stranded` — senders whose messages we consistently cannot read.
   * `outOfSync` — every sender we have heard from is stranded, i.e. nobody
   * in the circle can reach us. That is the case where *this* device is the
   * one on the wrong branch and rejoining is the remedy; a single stranded
   * sender among several working ones means the problem is theirs, not ours.
   */
  verdict(group) {
    const s = this.groups.get(group);
    const stranded = [...(s?.counts ?? [])]
      .filter(([, n]) => n >= this.threshold)
      .map(([sender]) => sender)
      .sort();
    return {
      stranded,
      outOfSync: stranded.length > 0 && stranded.length === (s?.seen.size ?? 0),
    };
  }

  /** Forget a group entirely — on leave, or after a successful rejoin. */
  clear(group) {
    this.groups.delete(group);
  }
}

/**
 * The user-facing sentence. Kept here rather than in a component so the
 * wording is covered by the same tests as the rule that triggers it.
 *
 * There is no self-service repair to offer. Recovering means re-joining by
 * external commit, which needs a current GroupInfo, and the only GroupInfo
 * this client can obtain comes from an invite blob — our own parked invites
 * describe our own broken branch. So the honest instruction is to get a link
 * from somebody whose circle still works.
 */
export function forkMessage({ stranded, outOfSync }, name) {
  if (outOfSync) {
    return `"${name}" is out of sync — this device is on a branch of its own and cannot read new messages. Ask a member for a fresh invite link and open it to rejoin.`;
  }
  if (stranded.length === 1) {
    return `messages from ${stranded[0]} in "${name}" cannot be read — their device may need to rejoin via a fresh invite link.`;
  }
  if (stranded.length > 1) {
    return `messages from ${stranded.join(', ')} in "${name}" cannot be read — their devices may need to rejoin via a fresh invite link.`;
  }
  return null;
}
