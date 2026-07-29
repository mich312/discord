# Security policy

quorum is an end-to-end-encrypted messenger. A vulnerability here can expose
private conversations, so please report one privately rather than opening a
public issue.

## Reporting

Open a **[private security advisory](https://github.com/mich312/discord/security/advisories/new)**
on this repository. That channel is preferred because it lets us discuss a
fix with you before anything is public.

Please include what you need to make the problem reproducible: the commit or
deployment you tested, the steps, and what an attacker gains. A proof of
concept is welcome but not required — a clear description of the flaw is
worth more than a working exploit.

**Expect an acknowledgement within 5 working days.** This is a small project
without a staffed security team; if you have not heard back in that time,
please chase, because it means the message did not reach anyone rather than
that it was ignored.

## Disclosure

We will agree a disclosure date with you. The default is 90 days from the
report, or the day a fix ships, whichever comes first. If a flaw is being
exploited we will move faster and say so publicly at the time. We will credit
you by whatever name you prefer, or not at all if you would rather.

We will not take legal action over good-faith research against your own
deployment. Please do not test against someone else's relay, and please do
not access, modify, or retain other people's data — the point is to find
flaws, and nothing about this design requires touching a real user to do it.

## What is in scope

The client, the relay, the crypto core, and the deployment assets in this
repository. In particular:

- Anything that lets a relay operator read message content, join a group, or
  impersonate a member. This is the core guarantee; a break here is critical.
- Key handling: the identity key, MLS group state, the account vault, the
  circles backup, per-channel room keys, and the key directory that decides
  which identity key speaks for which member.
- Anything that lets one member write a log entry in another's name, or
  rewrite or delete a line they did not write.
- Authentication and authorization on the relay, including the invite gate.
- Client-side execution: XSS, the sandboxed game iframe, the service worker.

## What is out of scope, and why

These are **known and documented properties of the design**, not
undiscovered bugs. Reporting them is welcome as an argument that the trade is
wrong, but they will not be treated as vulnerabilities:

- **The relay sees metadata.** Who talks to whom, when, how often, group
  sizes, and call participation. E2EE hides content, not traffic shape.
- **The relay serves the client.** A hostile operator can ship targeted
  JavaScript to one user. A strict CSP and SRI on the entry assets narrow
  this; only reproducible builds and a packaged client would close it. This
  is the fundamental limit of web-delivered E2EE and it is stated in the
  README.
- **WebRTC exposes IP addresses to call peers.** Media is peer-to-peer by
  design; every participant in a call learns the others' addresses unless
  TURN is configured as a relay.
- **Invite-link controls are server-enforced.** Expiry and max-uses can be
  bypassed by a malicious relay. Membership itself is cryptographic and
  cannot be.
- **There is no forward secrecy for message content.** Every channel keeps
  its conversation on the relay under a room key the whole roster holds, so
  anyone admitted later can read the past and one leaked key opens
  everything it ever covered. Deliberate, and said in the room header.
- **A deletion cannot reach a device that already read the line.** The
  relay drops the entry and readers fold a tombstone over it; that is all
  it can do.
- **The relay records which member appended each log entry.** It sees this
  at write time regardless; keeping it is what authorizes a deletion and
  what lets a device learn what it missed without downloading every
  channel.
- **Password vaults are offline-grindable by the server** for weak
  passwords. Argon2id (19 MiB, t=2). Passkey vaults have no such surface.

If you believe one of these is worse than documented — for example that a
leak is larger in practice than the README claims — that *is* in scope, and
we would like to hear it.

## Known unfixed issues

Tracked openly rather than quietly, in `docs/HARDENING_PLAN.md`:

- `password_login` is a replayable bearer credential. A captured request body
  can be replayed to retrieve the (still Argon2id-sealed) vault ciphertext.
  The fix requires a design decision, laid out in the plan.
- There is no device revocation and no identity key rotation.
- Groups that forked before the epoch compare-and-swap landed stay forked.
- **RUSTSEC-2026-0202** — `libcrux-sha3` 0.0.8, reached through
  `hpke-rs -> openmls_rust_crypto`, panics in its AVX2 SHAKE-256 path on
  output lengths > 32 not divisible by 8. Fixed upstream in 0.0.10, but
  `hpke-rs` 0.6.1 pins `^0.0.8` and 0.0.x releases are semver-incompatible,
  so the bump is blocked until `openmls_rust_crypto` moves. Impact is a
  panic, not key compromise. Whether our ciphersuite ever calls SHAKE-256
  with a qualifying length is unverified — assume reachable.

## No bug bounty

There is no money. This is an independent project; what we can offer is a
prompt reply, credit, and a fix.
