# quorum — design guidelines

The rules the interface is held to. Every one of them was written because a
review found the product breaking it, and most of them name the place. They
are phrased so a reviewer can say pass or fail without arguing about taste.

Where a rule is checked by a test, the test is named. **Prefer adding the
check to arguing the rule** — this document has drifted from the code twice
already. `client/README.md` described a design system ("the register":
signal-yellow, 0–2px radii, no pills, no gradients) that had been replaced
wholesale; and `styles.css` carried a comment claiming a contrast fix, quoting
the exact ratios that were still failing one token over. Prose does not hold.

The current register is **afterdark**: true-black neutral surfaces, one coral
signal, green reserved for live presence and cryptographic fact, soft
geometry (10px radii, round avatars, pills for counts), and monospace as the
system's speaking voice. Two themes off one token contract — `carbon` (dark,
default) and `paper` (light).

---

## 1. Colour is a controlled vocabulary

The palette carries meaning. When a colour means more than one thing it stops
meaning anything, and the meaning it loses first is the one that mattered.

**1.1 — Coral (`--accent`) means exactly three things: the selected thing, the
one primary action in view, and keyboard focus.** It never marks identity,
counts, encryption, titles, or warnings. *At review time coral was doing nine
jobs — a coral `VIA LINK` (a caution), a coral `3` (a neutral count) and a
coral `YOU` (a fact) sat within 40px of each other.*

**1.2 — Green (`--ok`) means a cryptographic fact holds, or someone is here
right now.** Verification, encryption-in-effect, presence, speaking, live
rooms. It never means "success", and it never carries connectivity —
rendering a websocket's health in the same green as a verified key teaches
"green = safe" and then spends it on a socket.

**1.3 — Amber (`--warn`) means a guarantee is reduced or unchecked.**
Unverified members, kept-history rooms, degraded encryption claims. Distinct
from `--danger`, which means broken or irreversible.

**1.4 — Red (`--danger`) means broken, or irreversible.** One visual form per
product. *Leaving a call was coral text in the sidebar, a coral outline button
in the call header, and bare coral uppercase in the game dock.*

**1.5 — Adding a fourth meaning to an existing colour token is a defect**, not
a shortcut. If a new state needs a colour, it needs a token, and a token needs
three consumers (§2.4).

**1.6 — No state is signalled by hue alone.** Verification, presence,
speaking, unread, live, muted, selected, pending and failed each need a second
channel: a glyph, a word, a shape, a border weight, or an `.sr-only` span.
*Review test: render the screen in greyscale. If two states become identical,
it fails.*

---

## 2. Tokens

**2.1 — No raw colour outside the token blocks.** Hex, `rgb()`, `rgba()`,
`hsl()` and named colours appear only in `:root`, `[data-theme='paper']`, and
the `prefers-color-scheme` mirror. Three exemptions: video letterbox `#000`,
the `--on-hue`/`--scrim` definitions themselves, and
`transparent`/`currentColor`/`inherit`. → `tokens.test.mjs`

**2.2 — Every `var(--x)` resolves to a definition in this file.** *`--warn`
and `--r-md` shipped for months as undefined tokens whose hardcoded fallbacks
always won — the amber never changed with the theme and measured 2.49:1 on
paper.* → `tokens.test.mjs`

**2.3 — No `var()` fallback for a token that exists.** `var(--danger,
#c0392b)` is banned: it silently survives a rename and reads as uncertainty
about the contract. → `tokens.test.mjs`

**2.4 — A new token requires three consumers.** Fewer than three call sites,
use the literal with a comment. A token with fewer than three consumers is
deleted. *The token layer must not become a second, worse stylesheet.*

**2.5 — Naming is `--<role>-<modifier>`, semantic not literal.** `--ink-dim`,
not `--grey-400`. `--s-3`, not `--space-12px`. **A token name must never
encode its own value** — that is how a scale becomes unrenameable.

**2.6 — Spacing comes from the scale.** `padding`, `margin`, `gap` and `inset`
take `var(--s-*)`, `0`, `auto`, a percentage, `calc()`, `env()`, or a
`ch`/`vh` measure. *There was no spacing scale at all: 523 literal
declarations across 35 distinct pixel values, of which the top six covered
66%. A scale existed; nobody had written it down, so 5/7/9/11/13px filled in
as noise.* → `scale.test.mjs`

**2.7 — Font size comes from `--text-*`.** No literal px in `font-size` or in
the `font` shorthand's size slot, and never a decimal size. *`13px` was the
most-used size in the product and was not a token — it out-used `--text-md`,
`--text-base`, `--text-lg`, `--text-xl` and `--text-display` combined.* →
`scale.test.mjs`

**2.8 — Duration comes from `--fast`/`--slow`.** *Five components
independently chose `.12s` because neither existing tier fit — that is the
scale telling you it is missing a step. Add the step; don't bypass it.* →
`scale.test.mjs`

**2.9 — `z-index` takes a `--z-*` token,** or is `0`/`1` inside a local
stacking context with a comment saying so. *The layering model was real and
coherent — and existed only in a prose comment.* → `scale.test.mjs`

---

## 3. Contrast and theme parity

**3.1 — Every foreground token clears 4.5:1 against every surface it can sit
on, in both themes.** Non-text uses — borders, rings, dividers — clear 3:1.
Exemptions carry an inline comment naming the measured ratio and the reason,
and are enumerated in the test's allowlist. Never silent. → `contrast.test.mjs`

**3.2 — A comment that claims a ratio is a test assertion, not prose.** If the
number is not in the test, do not write it in the CSS. *This is the rule that
paid for itself: the header comment announced a fix and quoted 3.71:1 and
2.85:1 as the values corrected. Those were the live numbers of the token next
door, which carried ~90 colour declarations of 10–12px metadata.*

**3.3 — Every colour token in `:root` has an override in both paper blocks;
every non-colour token has neither.** → `tokens.test.mjs`

**3.4 — A `[data-theme='paper']` component rule has a byte-identical
`:root:not([data-theme])` mirror, and vice versa.** Prefer fixing the token
over adding a mirror: the mirror list is a budget, not a pattern. → already
enforced by `theme.test.mjs`

**3.5 — Paper is authored, not derived.** Every alpha tint, every shadow and
the backdrop opacity are set independently per theme. **A light-theme tint
needs roughly half the alpha of a dark-theme tint to read at the same
subjective weight.** *Shipping one alpha for both turned a whisper of maroon
on black into a bubblegum band on cream — with a green button inside it.*

**3.6 — Never `outline: none` on `:focus`.** A custom focus treatment
*replaces* the indicator, never removes it, and clears 3:1 against its own
background. *Nine `outline: none` rules on inputs out-specified the global
`:focus-visible`, leaving a colour-only border swap as the sole cue.*

---

## 4. Typography

**4.1 — Monospace is the system's voice, and only that.** Labels, timestamps,
counts, epochs, states, ids, security lines. **It is never used for a person's
name, for body copy, or for a button label.** *A handle is the most human
thing in the product; it appeared in four different type specs in one
session, two of them mono.*

**4.2 — One concept, one type spec.** A handle is `600 13px var(--sans)`
everywhere it appears — roster, transcript, call stage, dock, self-card.

**4.3 — Minimum type size is 10px (`--text-xs`), and only for uppercase mono
metadata.** Anything a user must read to make a decision — labels, errors,
badges that gate an action — is at least 12px. *9px badges with 0.1em tracking
were carrying trust state.*

**4.4 — All-caps monospace is reserved for machine data.** Ids, codes, key
strings, timestamps. **It may never carry a warning, a consequence, or
anything the user must act on** — all-caps mono is the visual language of
"ignore me", and users read it that way.

---

## 5. Layout and containers

**5.1 — Every horizontal edge in the main pane derives from
`--pane-gutter`.** Pane header, scroll body, composer, composer note and
overview scroll share one value; no component sets its own horizontal padding
on that column. *Four components used four gutters, so nothing in the pane
shared a left edge and the step was visible with the naked eye.*

**5.2 — Two container specs: row (`padding: 12px 14px`, `--r`) and card
(`padding: 16px 18px`, `--r-lg`).** Radius encodes size, not novelty. **Two
containers stacked in the same list have the same radius.** No three-sided
borders. *Six analogous row-cards in one scroll column had six paddings and
two radii.*

**5.3 — Exactly one filled button per card, per row, and per dialog.**
Everything else is an outline or a text button. **A live or joinable action
outranks a copy or launch action for the fill.** *A game with two people in it
got an outline button; "copy address" next to it got a coral fill.*

**5.4 — Dashed borders mean "empty slot awaiting content" and nothing else.**
A quiet button is quiet through colour, never through a dashed edge.

**5.5 — One tab grammar: text plus a 2px accent underline.** No accent-filled
pills, no raised-fill segments. *Three tab bars, three grammars.*

**5.6 — Reach for a primitive before inventing a class.** A new
`*-row`/`*-stack`/`*-chip`/`*-pill` name must justify why the primitive plus a
modifier does not fit. **A third verbatim copy of a declaration block is a
refactor, not a paste.**

**5.7 — Class names are kebab-case `feature-element[-modifier]`;** state
modifiers are standalone adjectives composed via `cx()`. **Never build a class
string with a ternary that repeats the base.** Never ship a class with no
rule — use `data-testid` for test hooks. → `vocabulary.test.mjs`

---

## 6. Icons and identity

**6.1 — Icons come from `icons.jsx` at 14, 18 or 24px only**, at stroke width
1.6 / 1.4 / 1.4. No text characters (`★`, `♞`) standing in for icons, no
emoji. User-supplied glyphs are desaturated before display. *Seventeen icon
sizes were in use, seven of them inside a 6px band.*

**6.2 — Icon and label agree.** A control labelled `back` uses a directional
glyph, not an `X`. **Two controls in one view may not have near-synonymous
labels.**

**6.3 — An identity orb is distinguishable from every other orb at 20px.**
Orbs vary in lightness as well as hue and stay within one hue family.
*Locking every orb to one lightness band made three of four members read as
the same lavender at roster size — the one job the orbs exist for.*

---

## 7. Navigation and state

**7.1 — The persistent nav marks the current location in every mode.** If the
main pane is showing something — room, call stage, game — exactly one nav row
is active and it names that thing. *The sidebar kept `# general` highlighted
during calls and games: wrong exactly when the answer is least obvious.*

**7.2 — Every full-pane takeover has a left-aligned back control naming its
return target.** No destructive action within 44px of it.

**7.3 — Reversible and irreversible actions never share a row, a size, or a
weight.** *`close` sat beside `leave call` — same size, adjacent, ~8px apart
at thumb height. Users tapped close, believed they had left, and stayed
live-mic'd.*

**7.4 — A control that dismisses a view while leaving a device active — mic,
camera, screen share — says so in its label, and the active state is shown
persistently wherever the user goes next.**

**7.5 — Default views are computed from state, never stored constants.** A
persisted preference applies only after an explicit user switch.

**7.6 — A nav label names the surface's primary job**, not its secondary
section.

**7.7 — Everything reachable by mouse in the roster, shelf or voice list is
reachable from ⌘K.** *Verifying a member — the product's entire trust model —
was mouse-only.*

**7.8 — Overlays never stack visually, but they do stack logically.** Opening
a second overlay from a first returns to the first on close.

**7.9 — Selection and current-page state are exposed to assistive tech.** A
visual `.active`/`.selected` class is accompanied by `aria-current`,
`aria-selected` or `aria-pressed`. **A class name is not an ARIA state.**

---

## 8. Accessibility floors

Non-negotiable. WCAG 2.2 AA is the floor, not the target.

**8.1 — Interactive elements are `<button>`, `<a>`, or a real form control.**
Every icon-only control gets an explicit `aria-label`; `title` alone is never
sufficient, because touch has no hover.

**8.2 — Never use `hidden` or `display: none` to hide a control that must stay
operable.** Use `.sr-only`, or the button-proxies-input pattern. *The file
attachment was a `<label>` wrapping a `hidden` input with an `aria-hidden`
icon: not focusable, no accessible name, and the only way to send a file.*

**8.3 — Every overlay uses `useDialog`.** `aria-modal`, a label, focus moved
in, Tab trapped, **Escape bound on the dialog element and not on a child
input**, focus restored to the opener on close. No hand-rolled
`role="dialog"`.

**8.4 — Anything that appears without a focus change is a status message.**
New messages, connection changes, toasts, form errors, call join/leave:
`role="status"` for information, `role="alert"` for failures. *Incoming
messages — the core function of the product — were never announced, while the
typing indicator was.*

**8.5 — Every pointer target is at least 24×24 CSS px at every width, and
44×44 below 821px.** Destructive actions get 48×48 on touch. Visual size may
stay small — grow the hit area with an `::after` overlay. **Enforce with an
automated sweep, not a hand-written list of selectors** — the allowlist
approach named nine selectors and left two dozen controls failing, including
`leave call` at 82×23.

**8.6 — The reduced-motion guard sets `animation-iteration-count: 1`, not just
a near-zero duration.** Every infinite animation declares a static end-frame.
*Setting duration to 0.01ms without capping iterations turned eight slow
pulses into ~100,000-per-second flicker — for the users who asked for less
motion.*

**8.7 — Every form control has a programmatically associated label.** A
wrapping `<label>` whose only content is an `aria-hidden` icon does not count.
Placeholders are hints, never names. Errors use `aria-describedby` and
`aria-invalid`.

**8.8 — Each pane has a heading; the document has exactly one `<h1>` at a
time.** Section labels styled as `.overline` are real `<h2>`/`<h3>` elements.
Repeated landmarks carry distinguishing `aria-label`s. There is a skip link.

**8.9 — Every sound the app plays is mirrored as announced text**,
independently of whether the sound is enabled. Every `<video>` has an
accessible name.

---

## 9. Responsive

**9.1 — Three tiers: phone ≤820px, tablet 821–1080px, desktop ≥1081px.** Every
width query uses one of these exact values. A new breakpoint needs a measured
content width as justification, never a device name.

**9.2 — No tier may be narrower than the tier below it.** Measure the main
column at `breakpoint ± 1px`. *At 821px the message pane was 329px — narrower
than the 390px phone layout it had just left.*

**9.3 — Zero horizontal scroll below 1080px.** For every view and tier:
`documentElement.scrollWidth === clientWidth`, **and** no `overflow-y: auto`
element has `scrollWidth > clientWidth + 1`. The second half is not optional —
`overflow-y: auto` computes `overflow-x` to `auto`, which hides overflow
inside a scroller instead of surfacing it. *The game hub was 701px of content
in a 390px pane, with the RSVP button off-screen.*

**9.4 — Every flex or grid item containing text sets `min-width: 0`.** Grid
items default to min-content, the single most common cause of 9.3 failures.

**9.5 — No security disclosure, brand mark, or status text is removed for
layout.** Responsive rules may abbreviate, collapse, or move — **`display:
none` on any of these is a defect.** *Mobile dropped the entire invite-screen
brand panel, both security disclosures, and the connection label, while
keeping the unconditional "end-to-end encrypted" footer.*

**9.6 — Every `:hover`-gated affordance has a `@media (hover: none)`
counterpart, and that counterpart is not "always visible."** Reveal on touch
is state-driven. *"Always visible" on a 390px screen means "always in the
way": 14 toolbars, each 47% of the viewport width, floating over the
transcript.*

**9.7 — Every element that can touch a viewport edge carries the matching
`env(safe-area-inset-*)`.** *The call and game composers sat 31px from the
bottom on a phone whose home-indicator inset is 34px.*

**9.8 — Heights use `dvh`/`svh` behind `@supports`, never bare `vh`,** for
anything the user must reach. Text inputs are ≥16px below 821px, or iOS zooms.

**9.9 — Screenshot and visual-regression contexts set `hasTouch: true,
isMobile: true` at phone widths.** *A mobile screenshot taken on a
hover-capable context renders a layout no user will ever see — and this
review spent its first pass arguing with exactly those pixels.*

**9.10 — Animate only `transform`, `opacity` and `filter`.** `box-shadow`,
`width`, `height`, `top`/`left` are banned in `@keyframes` — use a
pseudo-element. Reduced-motion support does not exempt an animation.

**9.11 — Lists that can exceed ~150 rows are windowed**, and no row carries a
per-row absolutely-positioned overlay. All `<img>` carry `loading="lazy"`,
`decoding="async"` and intrinsic dimensions.

---

## 10. Security communication

The product's differentiator is invisible and its costs are visible. These
rules exist so the interface never spends the user's trust on a claim it
cannot keep.

**10.1 — A security claim may only render in states where it is
unconditionally true.** "End-to-end encrypted" is not a static string; it is a
function of verified members, kept-history, connection and sync state. If it
holds only under a precondition, state the precondition or degrade the claim.
*The footer rendered identically with unverified members present, in
kept-history rooms, and while offline.*

**10.2 — Content with weaker authentication never renders with stronger
content's signals.** *Kept-history messages are room-key sealed, not
sender-signed — any former key holder can forge one. They rendered
pixel-identical to live messages and inherited the verified checkmark whose
tooltip reads "safety number checked on this device."*

**10.3 — State a claim's beneficiary, not just its existence.** "Encrypted" is
not a claim until you say from whom and to whom. Anything pairing "encrypted"
with a member count is asserting something about those identities.

**10.4 — Every trust-granting action has an equally weighted trust-denying
action.** A dialog whose only button increases trust is a consent funnel.
The negative path must persist its finding and say what to do next. *The
safety-number dialog had only "the numbers match".*

**10.5 — A warning is an affordance.** Any badge or chip describing a reduced
guarantee is itself the control that resolves it — one tap, no tooltip
required.

**10.6 — Warnings are budgeted: one persistent banner at a time, ranked by
severity.** Every warning is resolvable by an action the user can take.
Warnings have a lifecycle — appear, escalate, resolve or collapse. **No banner
renders identically on day 1 and day 90.**

**10.7 — Server-enforced limits are described as requests, not properties.**
Expiry, max-uses and retention are honoured by the relay, not by the
mathematics. Never state a bypassable control in the same voice as a
cryptographic one.

**10.8 — State the blast radius wherever a secret can be exported, copied or
displayed.** What it unlocks, on which devices, for how long, and whether it
can be rotated. **The safest export is the default and the visually primary
action.**

**10.9 — A change of security state is surfaced with weight proportional to
its consequence and persists until acknowledged.** **Losing a trust signal
renders as a loss, never as the absence of a badge.**

**10.10 — A limit is disclosed at the moment it takes effect, not only
after.** No-scrollback belongs in the invite dialog and the join screen — not
only in the watermark the joiner reads once they are already confused.

**10.11 — State the encryption promise once per surface.** Prose is reserved
for exceptions: game stages, kept-history rooms, invite links. *Repeating the
claim everywhere is what made the one place it genuinely differs read like
all the others.*

---

## 11. Language

**11.1 — Context before input.** No screen asks the user to type anything
before telling them, on that same screen, what the product is, what group this
is, and who invited them. **At every breakpoint.**

**11.2 — Never state a security fact without a consequence and an action.**
What is true → what it means for you → what to do about it.

**11.3 — One concept, one word — including in destructive dialogs.** *The UI
said "room" everywhere and the delete confirmation said "channel". A
destructive dialog using a word that appears nowhere else in the product is a
hazard, not a style nit.*

**11.4 — New vocabulary appears in at least three places or is replaced with a
plain word.** *`crew`, `seat` and `briefing` each appeared exactly once.*

**11.5 — Banned from user-facing copy:** MLS, RFC 9420, epoch, ratchet,
commit, KeyPackage, external commit, HKDF/AES-GCM/Argon2id, "key packages",
raw key bytes by default, and *forward secrecy* unqualified — always pair it
with its consequence in plain words. **No raw server, relay or exception
message is ever interpolated into user-facing text.** *A non-technical
organiser adding a friend was shown "has no published key packages (have they
signed up?)".*

**11.6 — Banned fear vocabulary in steady-state UI:** *forever, gone, lost,
destroyed, you can never, refusing, danger*. Risks are stated once, calmly,
next to the button that resolves them. *A permanent undismissable red bar told
users by name that they would be "gone forever", forty seconds after they
joined.*

**11.7 — Nothing blocks entry except an action that takes one tap.** Security
setup is post-entry and staged. **Where a hard gate is genuinely warranted,
gate on the strongest option, not the weakest** — and gate on a checkbox
making a specific factual claim the user can be true or false about, never a
vague "I understand".

**11.8 — Errors name the thing and say what to do.** Unknown failures render
as plain language with the technical detail behind a disclosure.

**11.9 — Every input that performs an action has a visible, labelled button.**
No Enter-only submits. **No form discards typed input on blur.** *Typing a
group name and clicking anywhere else discarded it silently.*

**11.10 — Empty states name the next action and who can take it.** "Only
admins can do X" must also say which admins.

**11.11 — Tooltips carry no unique meaning.** Anything in a `title` also
exists as visible text or a tappable affordance.

**11.12 — Nothing truncates silently.** Every clipped value gets an ellipsis
and a way to see it in full.

---

## 12. Enforcement

Rules that are only prose drift. These are the checks that hold them.

| Test | Asserts | Rules |
|---|---|---|
| `contrast.test.mjs` | WCAG matrix over every text token × every surface, both themes | 3.1, 3.2 |
| `tokens.test.mjs` | no raw colour outside token blocks; no undefined tokens; no dead tokens; no fallback on a defined token; colour-token theme parity | 2.1–2.3, 3.3 |
| `scale.test.mjs` | spacing, type and motion literals held to today's count; the 10px floor and the z-index scale asserted at zero | 2.6–2.9, 4.3 |
| `vocabulary.test.mjs` | JSX ↔ CSS class integrity; no base-duplicating ternary; inline-style budget | 5.7 |
| `theme.test.mjs` | paper block ⇔ media-query mirror parity | 3.4 |
| `copy.test.mjs` | banned protocol and fear vocabulary in user-facing strings under `client/src/**` | 11.5, 11.6 |

**Allowlists shrink, never grow.** Each linter is seeded with today's
violation count and the count is a ceiling, so existing debt is visible and
new debt is impossible.

**Visual-regression testing is deliberately not proposed.** There are no
baselines, `npm run e2e` does not run in CI, and golden-image tests are the
most likely of any check here to be disabled after the third false positive.
`npm run shots:ui` exists for human review instead — 42 shots across both
themes and both viewports, which is what this review was conducted on.
