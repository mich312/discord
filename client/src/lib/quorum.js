// Nobody adds a member alone.
//
// Membership is the only thing in this product that is genuinely
// irreversible: everyone admitted to a circle can read everything its room
// keys unlock, back to the first message anyone sent, and removing them later
// does not take that back. It was, until now, one admin's click.
//
// So it becomes the circle's decision. A member proposes somebody; the circle
// signs; at the threshold it carries. Proposing counts as a signature — you
// do not put a name forward and then abstain on it — and an objection is
// recorded beside the count rather than cancelling it, because "I think this
// is a bad idea" and "this may not proceed" are different claims and only the
// first is one member's to make.
//
// What this is NOT, and the UI says so plainly: cryptographic enforcement.
// The relay's ACL still requires an admin to execute the add, and a modified
// client could skip the ledger. The signatures are real — every log entry is
// Ed25519-signed by its author — and every member sees the same ledger, which
// is what makes an admin who ignores it visible. Making the relay refuse an
// add without the signatures is the next step, and it costs telling the relay
// each circle's threshold, which is a trade worth making deliberately rather
// than in passing.
//
// Pure, like the rest of the shared-state modules: everything here crosses
// devices inside MLS envelopes, so it is normalized on receive with
// whitelisted fields and bounded sizes.

export const WHY_MAX = 400;
export const PROPOSALS_MAX = 16;
/** Signers and objectors, bounded to something well past a circle's size. */
const VOICES_MAX = 64;
const MIN = 60e3;

/**
 * What a circle asks of itself before it lets somebody in.
 *
 * A simple majority, and never fewer than two — the whole point is that one
 * person cannot do it, so a threshold of one is not a lower setting, it is
 * the feature switched off. A circle of one is the exception: there is
 * nobody else to ask.
 */
export function defaultThreshold(memberCount) {
  const n = Math.max(1, Number(memberCount) || 1);
  if (n === 1) return 1;
  return Math.max(2, Math.ceil(n / 2));
}

/** Clamp a threshold to something a circle of this size can actually reach.
    A threshold above the member count is a circle that can never admit
    anyone, which is a state the UI should not be able to get into. */
export function normalizeThreshold(value, memberCount) {
  const n = Math.max(1, Number(memberCount) || 1);
  const v = Math.floor(Number(value));
  if (!Number.isFinite(v)) return defaultThreshold(n);
  return Math.min(n, Math.max(n === 1 ? 1 : 2, v));
}

/**
 * One proposal as received. `by` is the MLS-authenticated sender, never the
 * payload — the whole ledger is worthless if a member can post a proposal
 * under somebody else's name.
 *
 * Proposing counts as signing, which is why `signatures` starts with the
 * proposer rather than empty.
 */
export function normalizeProposal(p, by, now = Date.now()) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id ?? '').slice(0, 40);
  const handle = String(p.handle ?? '').slice(0, 64).trim().toLowerCase();
  const why = String(p.why ?? '').slice(0, WHY_MAX).trim();
  let at = Number(p.at);
  if (!Number.isFinite(at) || at <= 0 || at > now + MIN) at = now;
  if (!id || !handle || !by) return null;
  return {
    id,
    handle,
    ...(why ? { why } : {}),
    by: String(by),
    at,
    signatures: [{ who: String(by), at }],
    objections: [],
  };
}

/** Insert-or-replace, newest first, capped. A re-proposal of the same id
    keeps the signatures already on it. */
export function upsertProposal(list, proposal) {
  if (!proposal) return list ?? [];
  const prior = (list ?? []).find((p) => p.id === proposal.id);
  const kept = prior
    ? { ...proposal, signatures: prior.signatures, objections: prior.objections }
    : proposal;
  return [kept, ...(list ?? []).filter((p) => p.id !== proposal.id)]
    .sort((a, b) => b.at - a.at)
    .slice(0, PROPOSALS_MAX);
}

/** Sign. One signature per member — signing twice is not two signatures, and
    an objector who changes their mind stops objecting. */
export function applySignature(list, id, who, at = Date.now()) {
  return (list ?? []).map((p) => {
    if (p.id !== id) return p;
    if (p.signatures.some((s) => s.who === who)) return p;
    if (p.signatures.length >= VOICES_MAX) return p;
    return {
      ...p,
      signatures: [...p.signatures, { who: String(who), at }],
      objections: p.objections.filter((o) => o.who !== who),
    };
  });
}

/**
 * Object, with a reason.
 *
 * Deliberately does not touch the count. An objection is a member saying "I
 * think this is a bad idea, and here is why", recorded where the proposer and
 * everyone else will read it. Letting one member veto would make the
 * threshold decorative, and letting an objection sit invisibly beside a
 * carried proposal would make it decorative in the other direction.
 */
export function applyObjection(list, id, who, why, at = Date.now()) {
  const reason = String(why ?? '').slice(0, WHY_MAX).trim();
  if (!reason) return list ?? [];
  return (list ?? []).map((p) => {
    if (p.id !== id) return p;
    if (p.objections.length >= VOICES_MAX && !p.objections.some((o) => o.who === who)) return p;
    return {
      ...p,
      signatures: p.signatures.filter((s) => s.who !== who),
      objections: [...p.objections.filter((o) => o.who !== who), { who: String(who), why: reason, at }],
    };
  });
}

/** Signatures that still come from people in the circle. A member who has
    left does not keep voting, and their name should not prop up a count. */
export function standingSignatures(proposal, members) {
  const roster = new Set(members ?? []);
  return (proposal?.signatures ?? []).filter((s) => roster.has(s.who));
}

/** Has it carried? */
export function isCarried(proposal, threshold, members) {
  return standingSignatures(proposal, members).length >= Math.max(1, threshold);
}

/** Whether this member still has something to do about it. */
export function awaitingFrom(proposal, who) {
  if (!proposal) return false;
  return (
    !proposal.signatures.some((s) => s.who === who) &&
    !proposal.objections.some((o) => o.who === who)
  );
}

/** Who may withdraw one: whoever put it forward, or an admin. */
export function canWithdraw(proposal, requester, isAdmin) {
  if (!proposal) return false;
  return proposal.by === requester || isAdmin === true;
}

/**
 * Which member executes a carried proposal.
 *
 * The relay's ACL still wants an admin, and every member's client watches the
 * same ledger — so without a rule, every admin online would call `addMember`
 * at once. The first admin in roster order, and only them: deterministic, so
 * the same one acts on every device's reading of the same log.
 */
export function admitter(roles, members) {
  const admins = (members ?? []).filter((m) => roles?.[m] === 'admin').sort();
  return admins[0] ?? null;
}

/** Bound and clean a whole list off the wire (a meta rebroadcast). */
export function normalizeProposals(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      const base = normalizeProposal(p, p?.by, now);
      if (!base) return null;
      const voices = (arr, extra) =>
        (Array.isArray(arr) ? arr : [])
          .map((v) => {
            const who = String(v?.who ?? '');
            const at = Number(v?.at);
            if (!who) return null;
            return {
              who,
              at: Number.isFinite(at) && at > 0 ? at : base.at,
              ...(extra ? { why: String(v?.why ?? '').slice(0, WHY_MAX).trim() } : {}),
            };
          })
          .filter((v) => v && (!extra || v.why))
          .slice(0, VOICES_MAX);
      const signatures = voices(p.signatures, false);
      return {
        ...base,
        // The proposer's signature is implied by the proposal; a rebroadcast
        // that has lost it must not turn a 3-of-4 into a 2-of-4.
        signatures: signatures.some((s) => s.who === base.by)
          ? signatures
          : [...signatures, { who: base.by, at: base.at }],
        objections: voices(p.objections, true),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, PROPOSALS_MAX);
}

/** Union for the joiner gap-fill: ids this device already has win. */
export function mergeProposals(mine, incoming) {
  const have = new Set((mine ?? []).map((p) => p.id));
  return [...(mine ?? []), ...(incoming ?? []).filter((p) => p && !have.has(p.id))]
    .sort((a, b) => b.at - a.at)
    .slice(0, PROPOSALS_MAX);
}
