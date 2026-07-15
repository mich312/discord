# relay

Rust (axum) WebSocket server. A **delivery service and ordered log** —
nothing more.

## What it does

- Authenticates connections
- Stores opaque ciphertext blobs in Postgres, keyed by `(group_id, epoch, seq)`
- Enforces message ordering within a group
- Hosts pre-published KeyPackages (enables adding members who are offline)
- Stores encrypted `GroupInfo` blobs for invite links (with `expires_at` /
  max-use counters — server-enforced, therefore weak controls)
- Fans out to connected members

## What it cannot do — by design

- Read messages, group membership contents, or invite blobs
- It *can* observe metadata (who talks to whom, when, how often) and it
  *can* lie about delivery — which is why clients verify membership
  cryptographically and never trust the server's word for it.

Phase 2 work. Phase 1 uses a stub relay just good enough for two tabs.
