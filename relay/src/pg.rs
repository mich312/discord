//! Postgres-backed store. Blobs are keyed by (group_id, seq) with the
//! client-declared epoch stored alongside — exactly the shape in the build
//! plan. Uses runtime queries (no compile-time DB dependency).

use crate::store::{
    HistoryEntry, HistoryPage, InviteRecord, PasskeyDevice, PasskeyWrap, RegisterOutcome, Store,
    StoreError, StoredMessage, StoredWelcome, VaultRecord,
};
use async_trait::async_trait;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

/// Bump when a migration is NOT purely additive — i.e. when an older relay
/// could no longer operate correctly against the new shape. Additive changes
/// (a new table, a new nullable column) need no bump; the
/// CREATE TABLE IF NOT EXISTS batch in `migrate` handles those either way.
pub const SCHEMA_VERSION: i32 = 1;

/// Should this binary refuse to run against a database at version `found`?
///
/// Extracted from `migrate` so the comparison itself is testable without a
/// Postgres. It is a one-line rule with an outsized blast radius: get it
/// backwards and either every upgrade refuses to boot, or the rollback
/// corruption this exists to prevent happens silently.
///
/// `None` (no row yet) is a *fresh or pre-versioning* database, which is
/// exactly the case that must be allowed — every relay built before this
/// landed has no row, and refusing them would brick the upgrade that
/// introduces versioning.
pub fn schema_refusal(found: Option<i32>) -> Option<String> {
    match found {
        Some(v) if v > SCHEMA_VERSION => Some(format!(
            "database is at schema version {v}, but this relay understands {SCHEMA_VERSION}. \
             It was written by a newer build — upgrade the relay rather than rolling it back."
        )),
        _ => None,
    }
}

pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(backend)?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<(), StoreError> {
        // Concurrent CREATE TABLE IF NOT EXISTS races in postgres (duplicate
        // pg_type errors); serialize bootstrap across connections/processes.
        // The multi-statement batch runs as one implicit transaction, so the
        // xact-scoped lock holds until the DDL actually commits.
        sqlx::raw_sql(
            r#"
            SELECT pg_advisory_xact_lock(727276);
            CREATE TABLE IF NOT EXISTS users (
                user_id text PRIMARY KEY,
                pubkey bytea NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS key_packages (
                id bigserial PRIMARY KEY,
                user_id text NOT NULL REFERENCES users(user_id),
                payload bytea NOT NULL
            );
            CREATE TABLE IF NOT EXISTS groups (
                group_id text PRIMARY KEY,
                created_by text NOT NULL,
                last_seq bigint NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            -- The MLS epoch as the log has serialized it. Additive, so
            -- existing deployments pick it up at 0 and the first commit
            -- after upgrade sets it correctly.
            ALTER TABLE groups ADD COLUMN IF NOT EXISTS epoch bigint NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS group_members (
                group_id text NOT NULL REFERENCES groups(group_id),
                user_id text NOT NULL,
                role text NOT NULL DEFAULT 'member',
                PRIMARY KEY (group_id, user_id)
            );
            -- Pre-role deployments: add the column once and grandfather each
            -- group's creator in as its admin. Guarded so a later demotion
            -- isn't undone on the next boot.
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'group_members' AND column_name = 'role'
                ) THEN
                    ALTER TABLE group_members ADD COLUMN role text NOT NULL DEFAULT 'member';
                    UPDATE group_members gm SET role = 'admin'
                    FROM groups g
                    WHERE gm.group_id = g.group_id AND gm.user_id = g.created_by;
                END IF;
            END $$;
            CREATE TABLE IF NOT EXISTS messages (
                group_id text NOT NULL REFERENCES groups(group_id),
                seq bigint NOT NULL,
                epoch bigint NOT NULL,
                sender text NOT NULL,
                payload bytea NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (group_id, seq)
            );
            CREATE TABLE IF NOT EXISTS welcomes (
                id bigserial PRIMARY KEY,
                to_user text NOT NULL,
                from_user text NOT NULL,
                group_id text NOT NULL,
                after_seq bigint NOT NULL,
                payload bytea NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vaults (
                user_id text PRIMARY KEY REFERENCES users(user_id),
                kind text NOT NULL,
                salt bytea NOT NULL,
                verifier bytea NOT NULL,
                wrapped bytea NOT NULL,
                credential text,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            -- Additional per-device passkeys that unlock the same identity,
            -- keyed by credential id. Separate from vaults so enrolling one
            -- device never disturbs another's wrap.
            CREATE TABLE IF NOT EXISTS passkey_wraps (
                cred_id text PRIMARY KEY,
                user_id text NOT NULL,
                credential text NOT NULL,
                salt bytea NOT NULL,
                wrapped bytea NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            -- Device revocation needs a list a human can act on, so each wrap
            -- carries a name and an enrolment time. Both additive, so an
            -- older relay keeps working against this shape and SCHEMA_VERSION
            -- does not move.
            --
            -- `enrolled_at` duplicates `created_at` as plain unix seconds on
            -- purpose: sqlx here is built without the chrono/time features,
            -- so decoding timestamptz would mean adding a dependency to a
            -- crypto stack for the sake of one column. `created_at` stays for
            -- an operator reading the table by hand.
            ALTER TABLE passkey_wraps ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
            ALTER TABLE passkey_wraps ADD COLUMN IF NOT EXISTS enrolled_at bigint NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                user_id text NOT NULL,
                endpoint text NOT NULL,
                subscription text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, endpoint)
            );
            CREATE TABLE IF NOT EXISTS history (
                group_id text NOT NULL REFERENCES groups(group_id),
                hid text NOT NULL,
                seq bigint NOT NULL,
                ts bigint NOT NULL,
                expires_at bigint,
                payload bytea NOT NULL,
                PRIMARY KEY (group_id, hid, seq)
            );
            -- The authenticated writer of each entry. Needed to authorize a
            -- redaction and to count what someone else has said since you
            -- last looked; never returned to clients. Existing rows predate
            -- it and get '', which matches no handle — so an old entry can
            -- be redacted by an admin but not by its (unrecorded) author.
            --
            -- Additive, so SCHEMA_VERSION does not move and a rollback to
            -- the previous relay stays safe: the column has a default, so
            -- an older binary's INSERT (which never names it) still
            -- succeeds, and its SELECT never asks for it.
            ALTER TABLE history ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT '';
            -- Paging reads a channel newest-first; unread counts read by ts.
            CREATE INDEX IF NOT EXISTS history_page_idx ON history (group_id, hid, seq DESC);
            CREATE INDEX IF NOT EXISTS history_ts_idx ON history (group_id, hid, ts);
            -- Seqs outlive expiry/prune deletions (see append_history):
            -- re-issuing numbers would make client cursors skip entries.
            CREATE TABLE IF NOT EXISTS history_counters (
                group_id text NOT NULL,
                hid text NOT NULL,
                last_seq bigint NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, hid)
            );
            CREATE TABLE IF NOT EXISTS backups (
                user_id text PRIMARY KEY REFERENCES users(user_id),
                payload bytea NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            -- (invite, user) pairs that have already counted a use. The
            -- join flow presents an invite twice (Hello, then RedeemInvite),
            -- so uses are counted per claimant, not per presentation.
            CREATE TABLE IF NOT EXISTS invite_claims (
                invite_id text NOT NULL,
                user_id text NOT NULL,
                claimed_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (invite_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS invites (
                invite_id text PRIMARY KEY,
                group_id text NOT NULL REFERENCES groups(group_id),
                payload bytea NOT NULL,
                expires_at bigint,
                max_uses bigint,
                uses bigint NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now()
            );

            -- Schema version. Every migration so far has been additive, so
            -- the batch above was enough and downgrades worked by accident.
            -- The first destructive change breaks that, and without a
            -- recorded version an operator cannot tell which shape their
            -- database is in. Cheap now; not retrofittable after a bad
            -- upgrade.
            CREATE TABLE IF NOT EXISTS schema_version (
                id integer PRIMARY KEY CHECK (id = 1),
                version integer NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            );
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(backend)?;

        // Refuse to run against a database written by a NEWER relay: its
        // shape may have moved in ways this binary does not know about, and
        // operating on it regardless is how a rollback corrupts data. Older
        // is fine — the batch above brings it forward.
        let found: Option<i32> =
            sqlx::query_scalar("SELECT version FROM schema_version WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(backend)?;
        if let Some(why) = schema_refusal(found) {
            return Err(StoreError::Backend(why));
        }
        sqlx::query(
            "INSERT INTO schema_version (id, version) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET version = $1, applied_at = now()",
        )
        .bind(SCHEMA_VERSION)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        tracing::info!(version = SCHEMA_VERSION, "schema up to date");
        Ok(())
    }
}

fn backend(e: sqlx::Error) -> StoreError {
    StoreError::Backend(e.to_string())
}

#[async_trait]
impl Store for PgStore {
    async fn register_user(&self, user: &str, pubkey: &[u8]) -> Result<RegisterOutcome, StoreError> {
        let inserted = sqlx::query(
            "INSERT INTO users (user_id, pubkey) VALUES ($1, $2)
             ON CONFLICT (user_id) DO NOTHING",
        )
        .bind(user)
        .bind(pubkey)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        if inserted.rows_affected() == 1 {
            return Ok(RegisterOutcome::Registered);
        }
        let row = sqlx::query("SELECT pubkey FROM users WHERE user_id = $1")
            .bind(user)
            .fetch_one(&self.pool)
            .await
            .map_err(backend)?;
        Ok(RegisterOutcome::Existing(row.get("pubkey")))
    }

    async fn get_user_pubkey(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let row = sqlx::query("SELECT pubkey FROM users WHERE user_id = $1")
            .bind(user)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.map(|r| r.get("pubkey")))
    }

    async fn user_count(&self) -> Result<u64, StoreError> {
        let row = sqlx::query("SELECT count(*) AS n FROM users")
            .fetch_one(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.get::<i64, _>("n") as u64)
    }

    async fn publish_key_packages(&self, user: &str, payloads: Vec<Vec<u8>>) -> Result<(), StoreError> {
        for payload in payloads {
            sqlx::query("INSERT INTO key_packages (user_id, payload) VALUES ($1, $2)")
                .bind(user)
                .bind(payload)
                .execute(&self.pool)
                .await
                .map_err(backend)?;
        }
        Ok(())
    }

    async fn take_key_package(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let row = sqlx::query(
            "DELETE FROM key_packages WHERE id = (
                 SELECT id FROM key_packages WHERE user_id = $1
                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
             ) RETURNING payload",
        )
        .bind(user)
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?;
        Ok(row.map(|r| r.get("payload")))
    }

    async fn create_group(&self, group: &str, creator: &str) -> Result<(), StoreError> {
        let inserted = sqlx::query(
            "INSERT INTO groups (group_id, created_by) VALUES ($1, $2)
             ON CONFLICT (group_id) DO NOTHING",
        )
        .bind(group)
        .bind(creator)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        if inserted.rows_affected() == 0 {
            return Err(StoreError::GroupExists);
        }
        sqlx::query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')")
            .bind(group)
            .bind(creator)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn allow_member(&self, group: &str, user: &str) -> Result<(), StoreError> {
        let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
            .bind(group)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        if exists.is_none() {
            return Err(StoreError::NoSuchGroup);
        }
        sqlx::query(
            "INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
             ON CONFLICT DO NOTHING",
        )
        .bind(group)
        .bind(user)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn disallow_member(&self, group: &str, user: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2")
            .bind(group)
            .bind(user)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn delete_group(&self, group: &str) -> Result<(), StoreError> {
        // Children first: every table that references groups(group_id) has no
        // ON DELETE CASCADE, so the parent row can't go until they do. welcomes
        // and history_counters aren't FK-bound but are keyed by group, so clear
        // them too. One transaction so a delete is all-or-nothing.
        let mut tx = self.pool.begin().await.map_err(backend)?;
        for stmt in [
            "DELETE FROM invites WHERE group_id = $1",
            "DELETE FROM history WHERE group_id = $1",
            "DELETE FROM history_counters WHERE group_id = $1",
            "DELETE FROM messages WHERE group_id = $1",
            "DELETE FROM group_members WHERE group_id = $1",
            "DELETE FROM welcomes WHERE group_id = $1",
            "DELETE FROM groups WHERE group_id = $1",
        ] {
            sqlx::query(stmt).bind(group).execute(&mut *tx).await.map_err(backend)?;
        }
        tx.commit().await.map_err(backend)?;
        Ok(())
    }

    async fn is_member(&self, group: &str, user: &str) -> Result<bool, StoreError> {
        let row = sqlx::query("SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2")
            .bind(group)
            .bind(user)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.is_some())
    }

    async fn member_role(&self, group: &str, user: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2")
            .bind(group)
            .bind(user)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.map(|r| r.get("role")))
    }

    async fn set_member_role(&self, group: &str, user: &str, role: &str) -> Result<(), StoreError> {
        let updated = sqlx::query(
            "UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2",
        )
        .bind(group)
        .bind(user)
        .bind(role)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        if updated.rows_affected() == 0 {
            let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
                .bind(group)
                .fetch_optional(&self.pool)
                .await
                .map_err(backend)?;
            return Err(match exists {
                None => StoreError::NoSuchGroup,
                Some(_) => StoreError::Backend(format!("{user} is not a member of {group}")),
            });
        }
        Ok(())
    }

    async fn group_members(&self, group: &str) -> Result<Vec<(String, String)>, StoreError> {
        let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
            .bind(group)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        if exists.is_none() {
            return Err(StoreError::NoSuchGroup);
        }
        let rows = sqlx::query("SELECT user_id, role FROM group_members WHERE group_id = $1 ORDER BY user_id")
            .bind(group)
            .fetch_all(&self.pool)
            .await
            .map_err(backend)?;
        Ok(rows.into_iter().map(|r| (r.get("user_id"), r.get("role"))).collect())
    }

    async fn list_users(&self) -> Result<Vec<String>, StoreError> {
        let rows = sqlx::query("SELECT user_id FROM users ORDER BY user_id")
            .fetch_all(&self.pool)
            .await
            .map_err(backend)?;
        Ok(rows.into_iter().map(|r| r.get("user_id")).collect())
    }

    async fn list_groups(&self) -> Result<Vec<(String, String)>, StoreError> {
        let rows = sqlx::query("SELECT group_id, created_by FROM groups ORDER BY group_id")
            .fetch_all(&self.pool)
            .await
            .map_err(backend)?;
        Ok(rows.into_iter().map(|r| (r.get("group_id"), r.get("created_by"))).collect())
    }

    async fn append_history(
        &self,
        group: &str,
        hid: &str,
        author: &str,
        ts: u64,
        expires_at: Option<u64>,
        payload: Vec<u8>,
    ) -> Result<u64, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
            .bind(group)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?;
        if exists.is_none() {
            return Err(StoreError::NoSuchGroup);
        }
        // The counter upsert is atomic (the conflicting row is locked), so
        // concurrent appends serialize here and each gets a unique seq.
        let row = sqlx::query(
            "INSERT INTO history_counters (group_id, hid, last_seq) VALUES ($1, $2, 1)
             ON CONFLICT (group_id, hid)
             DO UPDATE SET last_seq = history_counters.last_seq + 1
             RETURNING last_seq",
        )
        .bind(group)
        .bind(hid)
        .fetch_one(&mut *tx)
        .await
        .map_err(backend)?;
        let seq: i64 = row.get("last_seq");
        sqlx::query(
            "INSERT INTO history (group_id, hid, seq, ts, expires_at, payload, author)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(group)
        .bind(hid)
        .bind(seq)
        .bind(ts as i64)
        .bind(expires_at.map(|t| t as i64))
        .bind(payload)
        .bind(author)
        .execute(&mut *tx)
        .await
        .map_err(backend)?;
        tx.commit().await.map_err(backend)?;
        Ok(seq as u64)
    }

    async fn sweep_expired_history(&self, now: u64) -> Result<u64, StoreError> {
        let done = sqlx::query("DELETE FROM history WHERE expires_at IS NOT NULL AND expires_at < $1")
            .bind(now as i64)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(done.rows_affected())
    }

    async fn history_page(
        &self,
        group: &str,
        hid: &str,
        page: HistoryPage,
        now: u64,
    ) -> Result<(Vec<HistoryEntry>, bool), StoreError> {
        let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
            .bind(group)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        if exists.is_none() {
            return Err(StoreError::NoSuchGroup);
        }
        // Expired ciphertext has no readers left to serve — drop it now.
        sqlx::query("DELETE FROM history WHERE group_id = $1 AND hid = $2 AND expires_at < $3")
            .bind(group)
            .bind(hid)
            .bind(now as i64)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        // Both directions ask for one row more than the caller wanted: the
        // extra row is how "is there anything older" is answered without a
        // second COUNT over the log.
        let (sql, bound, limit) = match page {
            HistoryPage::After { after, limit } => (
                "SELECT seq, ts, expires_at, payload, author FROM history
                 WHERE group_id = $1 AND hid = $2 AND seq > $3 ORDER BY seq ASC LIMIT $4",
                after,
                limit,
            ),
            HistoryPage::Before { before, limit } => (
                "SELECT seq, ts, expires_at, payload, author FROM history
                 WHERE group_id = $1 AND hid = $2 AND seq < $3 ORDER BY seq DESC LIMIT $4",
                before,
                limit,
            ),
        };
        let rows = sqlx::query(sql)
            .bind(group)
            .bind(hid)
            .bind(bound as i64)
            .bind(limit as i64 + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(backend)?;
        let more = rows.len() > limit as usize;
        let mut entries: Vec<HistoryEntry> = rows
            .into_iter()
            .take(limit as usize)
            .map(|r| HistoryEntry {
                seq: r.get::<i64, _>("seq") as u64,
                ts: r.get::<i64, _>("ts") as u64,
                expires_at: r.get::<Option<i64>, _>("expires_at").map(|t| t as u64),
                payload: r.get("payload"),
                author: r.get("author"),
            })
            .collect();
        let complete = match page {
            // A forward page only reaches the log's start when it began there.
            HistoryPage::After { after, .. } => after == 0 && !more,
            HistoryPage::Before { .. } => !more,
        };
        // Descending is a query-plan detail; callers always read ascending.
        if matches!(page, HistoryPage::Before { .. }) {
            entries.reverse();
        }
        Ok((entries, complete))
    }

    async fn history_count(
        &self,
        group: &str,
        hid: &str,
        after_ts: u64,
        exclude: &str,
        now: u64,
    ) -> Result<u64, StoreError> {
        let row = sqlx::query(
            "SELECT count(*) AS n FROM history
             WHERE group_id = $1 AND hid = $2 AND ts > $3 AND author <> $4
               AND (expires_at IS NULL OR expires_at >= $5)",
        )
        .bind(group)
        .bind(hid)
        .bind(after_ts as i64)
        .bind(exclude)
        .bind(now as i64)
        .fetch_one(&self.pool)
        .await
        .map_err(backend)?;
        Ok(row.get::<i64, _>("n") as u64)
    }

    async fn redact_history(
        &self,
        group: &str,
        hid: &str,
        seq: u64,
        caller: &str,
        admin: bool,
    ) -> Result<bool, StoreError> {
        // Authorship is checked inside the predicate rather than by a prior
        // read, for the same reason device deletion is (threat model §6.3):
        // a read-then-check races a concurrent write and turns the endpoint
        // into an oracle for who wrote what.
        let done = sqlx::query(
            "DELETE FROM history
             WHERE group_id = $1 AND hid = $2 AND seq = $3 AND ($4 OR author = $5)",
        )
        .bind(group)
        .bind(hid)
        .bind(seq as i64)
        .bind(admin)
        .bind(caller)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(done.rows_affected() > 0)
    }

    async fn prune_history(&self, group: &str, hid: &str, before_ts: u64) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM history WHERE group_id = $1 AND hid = $2 AND ts < $3")
            .bind(group)
            .bind(hid)
            .bind(before_ts as i64)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn set_backup(&self, user: &str, payload: Vec<u8>) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO backups (user_id, payload) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET payload = $2, updated_at = now()",
        )
        .bind(user)
        .bind(payload)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn get_backup(&self, user: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let row = sqlx::query("SELECT payload FROM backups WHERE user_id = $1")
            .bind(user)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.map(|r| r.get("payload")))
    }

    async fn set_vault(&self, user: &str, vault: VaultRecord) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO vaults (user_id, kind, salt, verifier, wrapped, credential)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id) DO UPDATE SET
               kind = $2, salt = $3, verifier = $4, wrapped = $5,
               credential = $6, updated_at = now()",
        )
        .bind(user)
        .bind(&vault.kind)
        .bind(&vault.salt)
        .bind(&vault.verifier)
        .bind(&vault.wrapped)
        .bind(&vault.credential)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn get_vault(&self, user: &str) -> Result<Option<VaultRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT kind, salt, verifier, wrapped, credential FROM vaults WHERE user_id = $1",
        )
        .bind(user)
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?;
        Ok(row.map(|r| VaultRecord {
            kind: r.get("kind"),
            salt: r.get("salt"),
            verifier: r.get("verifier"),
            wrapped: r.get("wrapped"),
            credential: r.get("credential"),
        }))
    }

    async fn add_passkey_wrap(&self, cred_id: &str, wrap: PasskeyWrap) -> Result<(), StoreError> {
        // The cred_id is client-chosen and a victim's is disclosed by the
        // passkey challenge, so an unconditional upsert let an attacker
        // re-point someone else's row at themselves and lock the victim out
        // of device recovery. Updating is allowed only for rows the caller
        // already owns.
        let updated = sqlx::query(
            "INSERT INTO passkey_wraps (cred_id, user_id, credential, salt, wrapped, label, enrolled_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (cred_id) DO UPDATE SET
               credential = $3, salt = $4, wrapped = $5, label = $6, enrolled_at = $7
             WHERE passkey_wraps.user_id = $2",
        )
        .bind(cred_id)
        .bind(&wrap.user)
        .bind(&wrap.credential)
        .bind(&wrap.salt)
        .bind(&wrap.wrapped)
        .bind(&wrap.label)
        .bind(wrap.created_at)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        if updated.rows_affected() == 0 {
            return Err(StoreError::CredentialTaken);
        }
        Ok(())
    }

    async fn get_passkey_wrap(&self, cred_id: &str) -> Result<Option<PasskeyWrap>, StoreError> {
        let row = sqlx::query(
            "SELECT user_id, credential, salt, wrapped, label, enrolled_at
             FROM passkey_wraps WHERE cred_id = $1",
        )
        .bind(cred_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?;
        Ok(row.map(|r| PasskeyWrap {
            user: r.get("user_id"),
            credential: r.get("credential"),
            salt: r.get("salt"),
            wrapped: r.get("wrapped"),
            label: r.get("label"),
            created_at: r.get("enrolled_at"),
        }))
    }

    async fn list_passkey_wraps(&self, user: &str) -> Result<Vec<PasskeyDevice>, StoreError> {
        let rows = sqlx::query(
            "SELECT cred_id, label, enrolled_at FROM passkey_wraps
             WHERE user_id = $1 ORDER BY enrolled_at DESC, cred_id ASC",
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await
        .map_err(backend)?;
        Ok(rows
            .into_iter()
            .map(|r| PasskeyDevice {
                cred_id: r.get("cred_id"),
                label: r.get("label"),
                created_at: r.get("enrolled_at"),
            })
            .collect())
    }

    async fn delete_passkey_wrap(&self, cred_id: &str, user: &str) -> Result<bool, StoreError> {
        // `user_id = $2` is in the WHERE clause, not a prior check: a
        // read-then-delete would let a request race a re-enrolment, and the
        // whole value of this call is that it cannot touch another account.
        let done = sqlx::query("DELETE FROM passkey_wraps WHERE cred_id = $1 AND user_id = $2")
            .bind(cred_id)
            .bind(user)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(done.rows_affected() > 0)
    }

    async fn list_passkey_vaults(&self) -> Result<Vec<(String, VaultRecord)>, StoreError> {
        let rows = sqlx::query(
            "SELECT user_id, kind, salt, verifier, wrapped, credential
             FROM vaults WHERE kind = 'passkey'",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(backend)?;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r.get("user_id"),
                    VaultRecord {
                        kind: r.get("kind"),
                        salt: r.get("salt"),
                        verifier: r.get("verifier"),
                        wrapped: r.get("wrapped"),
                        credential: r.get("credential"),
                    },
                )
            })
            .collect())
    }

    async fn put_push_subscription(
        &self,
        user: &str,
        endpoint: &str,
        subscription_json: &str,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO push_subscriptions (user_id, endpoint, subscription)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, endpoint) DO UPDATE SET subscription = $3",
        )
        .bind(user)
        .bind(endpoint)
        .bind(subscription_json)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn push_subscriptions_for(&self, user: &str) -> Result<Vec<(String, String)>, StoreError> {
        let rows = sqlx::query("SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = $1")
            .bind(user)
            .fetch_all(&self.pool)
            .await
            .map_err(backend)?;
        Ok(rows.into_iter().map(|r| (r.get("endpoint"), r.get("subscription"))).collect())
    }

    async fn delete_push_subscription(&self, user: &str, endpoint: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2")
            .bind(user)
            .bind(endpoint)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn append_message(
        &self,
        group: &str,
        epoch: u64,
        sender: &str,
        payload: Vec<u8>,
        commit: bool,
    ) -> Result<u64, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        // Commits compare-and-swap the epoch in the same transaction that
        // allocates the seq, so two racing commits cannot both win.
        let row = if commit {
            let updated = sqlx::query(
                "UPDATE groups SET last_seq = last_seq + 1, epoch = $2
                 WHERE group_id = $1 AND epoch = $2 - 1
                 RETURNING last_seq",
            )
            .bind(group)
            .bind(epoch as i64)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?;
            match updated {
                Some(r) => r,
                None => {
                    // Either the group is gone or another commit took this
                    // epoch first; tell them apart so the client can react.
                    let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
                        .bind(group)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(backend)?;
                    return Err(if exists.is_some() {
                        StoreError::EpochConflict
                    } else {
                        StoreError::NoSuchGroup
                    });
                }
            }
        } else {
            sqlx::query(
                "UPDATE groups SET last_seq = last_seq + 1 WHERE group_id = $1 RETURNING last_seq",
            )
            .bind(group)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?
            .ok_or(StoreError::NoSuchGroup)?
        };
        let seq: i64 = row.get("last_seq");
        sqlx::query(
            "INSERT INTO messages (group_id, seq, epoch, sender, payload)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(group)
        .bind(seq)
        .bind(epoch as i64)
        .bind(sender)
        .bind(payload)
        .execute(&mut *tx)
        .await
        .map_err(backend)?;
        tx.commit().await.map_err(backend)?;
        Ok(seq as u64)
    }

    async fn messages_after(&self, group: &str, after: u64) -> Result<Vec<StoredMessage>, StoreError> {
        let exists = sqlx::query("SELECT 1 FROM groups WHERE group_id = $1")
            .bind(group)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        if exists.is_none() {
            return Err(StoreError::NoSuchGroup);
        }
        let rows = sqlx::query(
            "SELECT seq, epoch, sender, payload FROM messages
             WHERE group_id = $1 AND seq > $2 ORDER BY seq",
        )
        .bind(group)
        .bind(after as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(backend)?;
        Ok(rows
            .into_iter()
            .map(|r| StoredMessage {
                group: group.to_string(),
                seq: r.get::<i64, _>("seq") as u64,
                epoch: r.get::<i64, _>("epoch") as u64,
                sender: r.get("sender"),
                payload: r.get("payload"),
            })
            .collect())
    }

    async fn store_welcome(&self, to: &str, welcome: StoredWelcome) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO welcomes (to_user, from_user, group_id, after_seq, payload)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(to)
        .bind(&welcome.from)
        .bind(&welcome.group)
        .bind(welcome.after as i64)
        .bind(&welcome.payload)
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn take_welcomes(&self, to: &str) -> Result<Vec<StoredWelcome>, StoreError> {
        let rows = sqlx::query(
            "DELETE FROM welcomes WHERE to_user = $1
             RETURNING from_user, group_id, after_seq, payload",
        )
        .bind(to)
        .fetch_all(&self.pool)
        .await
        .map_err(backend)?;
        Ok(rows
            .into_iter()
            .map(|r| StoredWelcome {
                from: r.get("from_user"),
                group: r.get("group_id"),
                after: r.get::<i64, _>("after_seq") as u64,
                payload: r.get("payload"),
            })
            .collect())
    }

    async fn create_invite(&self, invite: &str, record: InviteRecord) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO invites (invite_id, group_id, payload, expires_at, max_uses)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (invite_id) DO NOTHING",
        )
        .bind(invite)
        .bind(&record.group)
        .bind(&record.payload)
        .bind(record.expires_at.map(|t| t as i64))
        .bind(record.max_uses.map(|m| m as i64))
        .execute(&self.pool)
        .await
        // Was: string-matching "foreign key" on the error text, which is
        // brittle across sqlx and Postgres versions. SQLSTATE 23503 is the
        // foreign-key-violation code and is stable.
        .map_err(|e| match e.as_database_error().and_then(|d| d.code()) {
            Some(code) if code == "23503" => StoreError::NoSuchGroup,
            _ => backend(e),
        })?;
        Ok(())
    }

    async fn invite_group(&self, invite: &str) -> Result<Option<String>, StoreError> {
        let row = sqlx::query("SELECT group_id FROM invites WHERE invite_id = $1")
            .bind(invite)
            .fetch_optional(&self.pool)
            .await
            .map_err(backend)?;
        Ok(row.map(|r| r.get("group_id")))
    }

    async fn update_invite(&self, invite: &str, payload: Vec<u8>) -> Result<(), StoreError> {
        let updated = sqlx::query("UPDATE invites SET payload = $2 WHERE invite_id = $1")
            .bind(invite)
            .bind(payload)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        if updated.rows_affected() == 0 {
            return Err(StoreError::InviteInvalid);
        }
        Ok(())
    }

    async fn revoke_invite(&self, invite: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM invites WHERE invite_id = $1")
            .bind(invite)
            .execute(&self.pool)
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn redeem_invite(
        &self,
        invite: &str,
        user: &str,
        now: u64,
    ) -> Result<(String, Vec<u8>), StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;

        // Has this handle already spent a use of this link? The join flow
        // presents the invite twice, so the second presentation must not
        // count again.
        let claimed = sqlx::query("SELECT 1 FROM invite_claims WHERE invite_id = $1 AND user_id = $2")
            .bind(invite)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?
            .is_some();

        let row = if claimed {
            // Expiry still applies; the use count does not.
            sqlx::query(
                "SELECT group_id, payload FROM invites
                 WHERE invite_id = $1 AND (expires_at IS NULL OR expires_at >= $2)",
            )
            .bind(invite)
            .bind(now as i64)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?
        } else {
            // Atomic check-and-count so concurrent claims can't exceed
            // max_uses.
            sqlx::query(
                "UPDATE invites SET uses = uses + 1
                 WHERE invite_id = $1
                   AND (expires_at IS NULL OR expires_at >= $2)
                   AND (max_uses IS NULL OR uses < max_uses)
                 RETURNING group_id, payload",
            )
            .bind(invite)
            .bind(now as i64)
            .fetch_optional(&mut *tx)
            .await
            .map_err(backend)?
        };
        let row = row.ok_or(StoreError::InviteInvalid)?;

        sqlx::query(
            "INSERT INTO invite_claims (invite_id, user_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(invite)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(backend)?;
        tx.commit().await.map_err(backend)?;
        Ok((row.get("group_id"), row.get("payload")))
    }

    async fn claim_invite_for_registration(
        &self,
        invite: &str,
        user: &str,
        now: u64,
    ) -> Result<bool, StoreError> {
        match self.redeem_invite(invite, user, now).await {
            Ok(_) => Ok(true),
            Err(StoreError::InviteInvalid) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[test]
    fn a_database_from_a_newer_relay_is_refused() {
        // The whole point: rolling the binary back past a destructive
        // migration must fail loudly rather than operate on a shape it does
        // not understand.
        let why = schema_refusal(Some(SCHEMA_VERSION + 1)).expect("must refuse");
        assert!(why.contains(&(SCHEMA_VERSION + 1).to_string()), "{why}");
        assert!(why.contains(&SCHEMA_VERSION.to_string()), "{why}");
        assert!(why.contains("upgrade the relay"), "the message must say what to do: {why}");
    }

    #[test]
    fn the_current_version_runs() {
        assert_eq!(schema_refusal(Some(SCHEMA_VERSION)), None, "equal is not newer");
    }

    #[test]
    fn an_older_database_is_brought_forward_rather_than_refused() {
        // Older is the ordinary upgrade path; the CREATE TABLE IF NOT EXISTS
        // batch handles it. Refusing here would block every upgrade.
        assert_eq!(schema_refusal(Some(SCHEMA_VERSION - 1)), None);
        assert_eq!(schema_refusal(Some(0)), None);
        assert_eq!(schema_refusal(Some(i32::MIN)), None);
    }

    #[test]
    fn a_database_with_no_version_row_is_allowed() {
        // Every relay built before versioning landed has no row. Refusing
        // them would brick the very upgrade that introduces versioning —
        // this is the case most likely to be got wrong.
        assert_eq!(schema_refusal(None), None);
    }
}
