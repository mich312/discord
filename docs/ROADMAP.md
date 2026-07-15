# Roadmap

Where this sits: phases 1–7 of [BUILD_PLAN.md](BUILD_PLAN.md) are shipped.
This document orders what comes next, based on a gap analysis against
Discord (the skeleton we borrowed) and against the build plan's own
promises. Two principles drive the ordering:

1. **Ship what's already paid for.** Several features exist in the crypto
   core and the wire protocol but were never wired into the client. Those
   come first — they're wiring, not design.
2. **Never trade away honesty.** Every feature below is either compatible
   with E2EE or explicitly annotated with what it can and cannot
   guarantee. Anything that would require the relay to read content stays
   in non-goals, permanently.

---

## Milestone 1 — Close the trust loop

*Wiring over existing crypto. Small, and everything else leans on it.*

The invite modal tells users, verbatim: *"removing a member is what
actually rotates the keys."* The build plan's control table calls kick
**the strong control** — the only cryptographically enforced one. Neither
exists in the client. Until they do, the product's central security claim
points at a feature that isn't there.

| # | Work | Notes |
|---|---|---|
| 1.1 | **Kick a member** | `remove_member` already exists in crypto-core (returns the removal commit). Wire it through the controller, surface it in the roster (admin-gated once 2.2 lands; any member until then). Includes the kicked side: detect own removal in the `membershipChange` path, call `forgetGroup`, mark the circle as ended in the UI. Voice eviction already works (`membershipChanged`). Relay side: drop the user from the group ACL. |
| 1.2 | **Leave a circle** | MLS has no unilateral self-remove: a member proposes leaving, another member's commit makes it real. v1: local abandon (`forgetGroup` + delete the record) plus a `{k:'left'}` envelope so the roster shows intent; any remaining member's client then commits the removal — automatically, first client online wins. Until that commit lands the departed device technically still holds keys; the system message should say so rather than pretend otherwise. |
| 1.3 | **Invite management** | List outstanding invites (already persisted per-circle as `record.invites`), show expiry, revoke. `RevokeInvite` exists in the relay protocol and is currently never sent. UI copy repeats the asymmetry: revoking stops *new* joins; kicking is what rotates keys. |

**Exit criteria:** a group can get rid of someone, someone can get out of
a group, and every claim the docs and UI copy currently make about
membership control is true.

---

## Milestone 2 — Keep the plan's promises

*Everything here is a commitment BUILD_PLAN.md already made.*

| # | Work | Notes |
|---|---|---|
| 2.1 | **Scoped search** | Plan §2's answer to "no server-side search". Messages already live in IndexedDB; at 10–50-person group scale a linear scan per query is honestly fine — index later if it isn't. Persistent label: *"searching messages on this device."* Surface it in ⌘K. |
| 2.2 | **Admin/member roles** | The plan cut roles *beyond* admin/member; currently there are none at all — an unverified link-joiner can immediately mint invites and add members. Admin bit travels in the `meta` envelope (creator starts as admin, can grant). Gates: invites, add/remove member, channel management. Stated plainly in the docs: this is a client-enforced convention, not cryptography — a hostile client can ignore it. The real boundary remains MLS membership. |
| 2.3 | **Admin approval for link joins** | Plan §6's optional control, now buildable on 1.1 + 2.2. Honest mechanics: an external commit is cryptographically effective the moment it lands, so "pending" means the joiner can read from their join point onward while quarantined in the UI; *deny* = an admin's remove commit. The docs must not describe this as pre-join screening. |
| 2.4 | **Device & recovery screen** | Plan screen #5. Consolidates what exists but is scattered across modals and the nag banner: vault status (passkey/password/none), identity export (file / paste-string / recovery), storage-persistence state, and what signing in elsewhere does and doesn't restore. |
| 2.5 | **Circle settings screen** | Plan screen #4: rename circle, channel rename/delete, the invite list from 1.3, leave from 1.2. Channel deletion is a `meta` update — the plan calls channels "cheap and disposable," but today the list only ever grows. |
| 2.6 | **Message franking + report flow** | Plan §2's answer to "no content moderation," and the one item here needing real design: the WhatsApp scheme requires the relay to bind a signed context to each delivered blob (it can do this blind — group, seq, commitment tag). Design doc first, then implement. If it slips a milestone, slip it — but it's a standing promise, not a nice-to-have. |

---

## Milestone 3 — Daily-driver ergonomics

*The gap between "works" and "the group actually moves in." Every item is
an envelope kind or local state; none touches the trust model. Roughly
priority-ordered; most are independent and parallelizable.*

| # | Work | Notes |
|---|---|---|
| 3.1 | **Unread state** | Local read cursor per channel; badges on rail and channel list. The single most-felt daily gap. Pure client state. |
| 3.2 | **Mentions** | `@handle` in text; local highlight + notification priority. The relay never learns who was mentioned (push stays content-free — the nudge is unchanged, the client decides how loudly to render it). |
| 3.3 | **Stable message ids** | Prerequisite for 3.4/3.5/3.8: `(sender, per-sender counter)` carried in the chat envelope. Do this once, first. |
| 3.4 | **Edit & delete** | `{k:'edit', ref}` / `{k:'del', ref}` envelopes. Honest copy required: under E2EE every device already holds the plaintext, so deletion is a request other clients honor, not a server-enforced erasure. Discord can guarantee this; we can't, and the UI says so once, quietly. |
| 3.5 | **Replies** | A `ref` on the chat envelope; render as quote-above-message. |
| 3.6 | **Markdown subset** | Bold, italic, `code`, code blocks, links. Render-side only. **No remote link previews** — client-side fetching leaks reading activity to arbitrary hosts. If previews ever happen, they're sender-generated and travel inside the envelope (the Signal approach). |
| 3.7 | **Typing indicators** | Ride the existing MLS-encrypted ephemeral fan-out, exactly like voice presence. Throttled, best-effort, never stored. |
| 3.8 | **Pins** | `{k:'pin', ref}`, admin-gated, pinned list per channel. |
| 3.9 | **Voice: mute & speaking** | Today a joined mic is always live — there is no mute button. Local track enable/disable + a state flag on the existing `{k:'voice'}` envelope; speaking indicators from local audio levels. Push-to-talk after. |

---

## Milestone 4 — Reach

*Each item is a project with its own bill. Decide deliberately; none is
implied by the milestones above.*

| # | Work | Notes |
|---|---|---|
| 4.1 | **First-class DMs** | Sugar over two-person circles: "message @x" auto-creates or reuses one, rendered in its own rail section. Mostly UI + dedup rules; the crypto already handles it. Cheapest item in this milestone by far. |
| 4.2 | **Group voice at scale** | BUILD_PLAN phase 8: self-hosted SFU + SFrame keyed from the MLS exporter secret. Changes the infrastructure cost shape (bandwidth, not requests) and widens visible metadata (the SFU sees who's in the call). The plan's "uncomfortable question" applies unchanged: do this only if voice is the product. |
| 4.3 | **Video & screen share** | Mesh video dies at 3–4 participants; realistically gated on 4.2. 1:1 video is nearly free and could ship early as an exception. |
| 4.4 | **True multi-device** | Today "sign in elsewhere" copies one identity; devices are not independent MLS leaves and history never transfers. Real per-device leaves are a large MLS work item (per-group add of each new device, device revocation UX). The device screen from 2.4 is the honest stopgap. |
| 4.5 | **Mobile** | PWA hardening first (install prompts, iOS Web Push constraints documented rather than hidden). Native apps only if the PWA measurably fails the target groups. |

---

## Non-goals (standing)

Cut in the build plan, and staying cut — each either requires the relay
to read content or multiplies epoch complexity for something nobody
switches for:

- Public discovery / joinable public servers — structurally broken by
  no-scrollback, per plan §1.
- Server-side search, moderation, automod — the relay holds ciphertext.
- Scrollback for new joiners — forward secrecy is the product.
- Bots, webhooks, slash commands — a bot is a member holding keys; if
  ever revisited, it's under that framing and no other.
- Profiles beyond handle + seal, custom emoji, stickers, boosts —
  the visual register is deliberate (plan §7).
- Reactions and threads — cut in plan §7; revisit only after Milestone 3
  proves the envelope-kind pattern hasn't bloated epoch handling.

---

## Sequencing

```
M1 (trust loop) ──► M2.2 (roles) ──► M2.3 (approval queue)
                └─► M2.5 (settings screen: invites, leave)
M2.1 (search) — independent, any time
M3.3 (message ids) ──► 3.4 (edit/delete), 3.5 (replies), 3.8 (pins)
M3.* otherwise independent and parallelizable
M4.2 ──► 4.3 (group video rides the SFU)
```

Rough shape: M1 is days-to-a-week of work and unblocks the product's
core claims; M2 is a few weeks and makes the docs true; M3 is a steady
stream of small independent wins; M4 is where each item deserves its own
go/no-go conversation.
