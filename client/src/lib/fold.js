// Folding a flat message list into day dividers, system chips and sender
// groups.
//
// This lives in lib rather than beside the component because it is a security
// boundary, not a layout detail. A group renders one header, and that header
// carries the sender's trust badge — so which lines share a group decides
// which lines a badge vouches for. `fold.test.mjs` asserts that directly.

/** Messages from one sender inside this window fold into a single group. */
export const GROUP_WINDOW = 5 * 60 * 1000;

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return 'today';
  if (same(d, yesterday)) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function fold(messages) {
  const out = [];
  let day = null;
  let group = null;
  for (const m of messages) {
    const label = dayLabel(m.ts);
    if (label !== day) {
      out.push({ kind: 'day', label, key: `d${m.ts}` });
      day = label;
      group = null;
    }
    if (m.system) {
      out.push({ kind: 'system', m, key: `s${m.ts}${out.length}` });
      group = null;
      continue;
    }
    // Restored lines never join a live group. A live line is signed by the
    // sender's key and the check means "I compared that key"; a restored line
    // was never signed by its sender at all — it is sealed with the room key,
    // which every current *and former* member of a kept-history room holds.
    // One header cannot honestly speak for both.
    if (
      group &&
      group.sender === m.sender &&
      !!group.fromHistory === !!m.fromHistory &&
      m.ts - group.last < GROUP_WINDOW
    ) {
      group.lines.push(m);
      group.last = m.ts;
    } else {
      group = {
        kind: 'group',
        sender: m.sender,
        ts: m.ts,
        last: m.ts,
        lines: [m],
        fromHistory: !!m.fromHistory,
        key: `g${m.ts}${out.length}`,
      };
      out.push(group);
    }
  }
  return out;
}
