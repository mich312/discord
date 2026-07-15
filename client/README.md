# client

Web client (SvelteKit or React — undecided until Phase 3). Talks to
`crypto-core` running in a Web Worker; **never touches keys directly**.

## MVP screens (6, total)

1. Server rail + channel list
2. Channel — messages, composer, attachments
3. Member list → member detail with verification
4. Server settings — invites, channels, leave
5. Device management + recovery key
6. Onboarding — identity creation, recovery key export

**Explicitly cut:** profiles, reactions, threads, status/presence, roles
beyond admin/member.

## Load-bearing UI that Discord doesn't have

- Member list is primary — in E2EE it *is* the security boundary
- Permanent join-time watermark per channel (no scrollback exists)
- Safety numbers per member; link-joined members marked **unverified**
- Device list as a first-class settings screen
- Search labeled "searching messages on this device"
- Recovery-key status, visible and nagging until saved

## Delivery hardening (see plan §5.1)

Subresource Integrity on every asset, strict CSP (no `unsafe-inline` /
`unsafe-eval`), reproducible build with published hashes. This mitigates
broad silent attacks; it does not stop a targeted one — the docs say so.
