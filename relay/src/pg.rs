//! Postgres-backed store. Blobs are keyed by (group_id, seq) with the
//! client-declared epoch stored alongside — exactly the shape in the build
//! plan. Uses runtime queries (no compile-time DB dependency).

use crate::store::{RegisterOutcome, Store, StoreError, StoredMessage, StoredWelcome};
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
                PRIMARY KEY (group_id, user_id)
            );
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
        sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)")
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
            "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
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
}
