//! Postgres-backed store. Blobs are keyed by (group_id, seq) with the
//! client-declared epoch stored alongside — exactly the shape in the build
//! plan. Uses runtime queries (no compile-time DB dependency).

use crate::store::{InviteRecord, RegisterOutcome, Store, StoreError, StoredMessage, StoredWelcome, VaultRecord};
use async_trait::async_trait;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

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
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                user_id text NOT NULL,
                endpoint text NOT NULL,
                subscription text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, endpoint)
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
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(backend)?;
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
    ) -> Result<u64, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let row = sqlx::query(
            "UPDATE groups SET last_seq = last_seq + 1 WHERE group_id = $1 RETURNING last_seq",
        )
        .bind(group)
        .fetch_optional(&mut *tx)
        .await
        .map_err(backend)?
        .ok_or(StoreError::NoSuchGroup)?;
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
        .map_err(|e| {
            if e.to_string().contains("foreign key") {
                StoreError::NoSuchGroup
            } else {
                backend(e)
            }
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

    async fn redeem_invite(&self, invite: &str, now: u64) -> Result<(String, Vec<u8>), StoreError> {
        // Atomic check-and-count so concurrent redemptions can't exceed
        // max_uses.
        let row = sqlx::query(
            "UPDATE invites SET uses = uses + 1
             WHERE invite_id = $1
               AND (expires_at IS NULL OR expires_at >= $2)
               AND (max_uses IS NULL OR uses < max_uses)
             RETURNING group_id, payload",
        )
        .bind(invite)
        .bind(now as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?
        .ok_or(StoreError::InviteInvalid)?;
        Ok((row.get("group_id"), row.get("payload")))
    }
}
