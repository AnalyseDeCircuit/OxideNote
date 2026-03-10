//! Chat persistence — SQLite storage for chat sessions, messages, and token stats.
//!
//! Data lives in `<vault>/.oxidenote/chat.db`, separate from `index.db`
//! because index data is rebuildable while chat history is not.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ChatDbError {
    #[error("No vault opened")]
    NoVault,
    #[error("Chat database not initialized")]
    NoDatabase,
    #[error("Database error: {0}")]
    Db(String),
    #[error("IO error: {0}")]
    Io(String),
}

impl Serialize for ChatDbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for ChatDbError {
    fn from(e: rusqlite::Error) -> Self {
        ChatDbError::Db(e.to_string())
    }
}

impl From<std::io::Error> for ChatDbError {
    fn from(e: std::io::Error) -> Self {
        ChatDbError::Io(e.to_string())
    }
}

// ── Data types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRow {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    /// JSON-encoded image references
    pub images: Option<String>,
    /// JSON-encoded token usage
    pub usage: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSearchResult {
    pub message_id: i64,
    pub session_id: String,
    pub session_title: String,
    pub content_snippet: String,
    pub role: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStatsRow {
    pub lifetime_prompt: i64,
    pub lifetime_completion: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrateResult {
    pub sessions_imported: usize,
    pub messages_imported: usize,
}

// ── Database initialization ─────────────────────────────────

/// Open or create the chat database at `<vault>/.oxidenote/chat.db`.
pub fn open_chat_db(vault_path: &Path) -> Result<Connection, ChatDbError> {
    let db_dir = vault_path.join(".oxidenote");
    std::fs::create_dir_all(&db_dir)?;
    let db_path = db_dir.join("chat.db");
    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    create_chat_schema(&conn)?;

    Ok(conn)
}

fn create_chat_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        -- Application metadata
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

        -- Sessions
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT 'New Chat',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            archived    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

        -- Messages
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '',
            reasoning   TEXT,
            images      TEXT,
            usage       TEXT,
            created_at  INTEGER NOT NULL,
            sort_order  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sort_order);

        -- Full-text search on message content
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content=messages,
            content_rowid=id
        );

        -- FTS sync triggers
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        -- Token statistics
        CREATE TABLE IF NOT EXISTS token_stats (
            key    TEXT PRIMARY KEY,
            value  INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO token_stats (key, value) VALUES ('lifetime_prompt', 0);
        INSERT OR IGNORE INTO token_stats (key, value) VALUES ('lifetime_completion', 0);

        -- Agent run history
        CREATE TABLE IF NOT EXISTS agent_runs (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            status           TEXT NOT NULL,
            scope            TEXT,
            summary          TEXT,
            plan_json        TEXT,
            changes_json     TEXT,
            token_prompt     INTEGER NOT NULL DEFAULT 0,
            token_completion INTEGER NOT NULL DEFAULT 0,
            started_at       TEXT NOT NULL,
            completed_at     TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- AI memory: persistent facts and preferences across sessions
        CREATE TABLE IF NOT EXISTS memories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            content    TEXT NOT NULL,
            category   TEXT NOT NULL DEFAULT 'general',
            created_at INTEGER NOT NULL,
            pinned     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        ",
    )?;
    Ok(())
}

// ── Helper: acquire chat_db connection ──────────────────────

fn with_chat_db<F, R>(chat_db: &Arc<Mutex<Option<Connection>>>, f: F) -> Result<R, ChatDbError>
where
    F: FnOnce(&Connection) -> Result<R, ChatDbError>,
{
    let guard = chat_db.lock();
    let conn = guard.as_ref().ok_or(ChatDbError::NoDatabase)?;
    f(conn)
}

// ── Commands ────────────────────────────────────────────────

/// List chat sessions, sorted by most recently updated.
#[tauri::command]
pub async fn list_chat_sessions(
    limit: i64,
    offset: i64,
    include_archived: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatSession>, ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        let mut stmt = if include_archived {
            conn.prepare(
                "SELECT id, title, created_at, updated_at, archived
                 FROM sessions ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
            )?
        } else {
            conn.prepare(
                "SELECT id, title, created_at, updated_at, archived
                 FROM sessions WHERE archived = 0
                 ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
            )?
        };

        let rows = stmt.query_map(params![limit, offset], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                archived: row.get::<_, i32>(4)? != 0,
            })
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    })
}

/// Load a full session with all its messages.
#[tauri::command]
pub async fn load_chat_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(ChatSession, Vec<ChatMessageRow>), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        // Load session metadata
        let session = conn.query_row(
            "SELECT id, title, created_at, updated_at, archived
             FROM sessions WHERE id = ?1",
            params![session_id],
            |row| {
                Ok(ChatSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    archived: row.get::<_, i32>(4)? != 0,
                })
            },
        ).map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ChatDbError::Db(format!("Session not found: {}", session_id)),
            other => ChatDbError::from(other),
        })?;

        // Load all messages
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, reasoning, images, usage, created_at
             FROM messages WHERE session_id = ?1
             ORDER BY sort_order ASC",
        )?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ChatMessageRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                reasoning: row.get(4)?,
                images: row.get(5)?,
                usage: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }

        Ok((session, messages))
    })
}

/// Create a new chat session.
#[tauri::command]
pub async fn create_chat_session(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<ChatSession, ChatDbError> {
    let now = chrono::Utc::now().timestamp_millis();

    with_chat_db(&state.chat_db, |conn| {
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, now, now],
        )?;

        Ok(ChatSession {
            id,
            title,
            created_at: now,
            updated_at: now,
            archived: false,
        })
    })
}

/// Update a session's title.
#[tauri::command]
pub async fn update_chat_session_title(
    session_id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    let now = chrono::Utc::now().timestamp_millis();

    with_chat_db(&state.chat_db, |conn| {
        conn.execute(
            "UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, session_id],
        )?;
        Ok(())
    })
}

/// Delete a session, all its messages (CASCADE), and orphaned image files.
#[tauri::command]
pub async fn delete_chat_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
        Ok(())
    })?;

    // Best-effort cleanup of orphaned image files
    if let Some(vault) = state.vault_path.read().as_ref() {
        let images_dir = vault.join(".oxidenote").join("chat_images").join(&session_id);
        let _ = std::fs::remove_dir_all(&images_dir);
    }

    Ok(())
}

/// Save a single message to a session. Returns the auto-generated message ID.
#[tauri::command]
pub async fn save_chat_message(
    session_id: String,
    role: String,
    content: String,
    reasoning: Option<String>,
    images: Option<String>,
    usage: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, ChatDbError> {
    let now = chrono::Utc::now().timestamp_millis();

    with_chat_db(&state.chat_db, |conn| {
        // Atomic sort_order computation via subquery — avoids race on concurrent inserts
        conn.execute(
            "INSERT INTO messages (session_id, role, content, reasoning, images, usage, created_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_id = ?1))",
            params![session_id, role, content, reasoning, images, usage, now],
        )?;

        let msg_id = conn.last_insert_rowid();

        // Update session's updated_at
        conn.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;

        Ok(msg_id)
    })
}

/// Full-text search across chat message content.
#[tauri::command]
pub async fn search_chat_messages(
    query: String,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<Vec<ChatSearchResult>, ChatDbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Sanitize FTS5 query: wrap each word in double-quotes to escape operators
    let sanitized = query
        .split_whitespace()
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");

    with_chat_db(&state.chat_db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT m.id, m.session_id, s.title, snippet(messages_fts, 0, '**', '**', '...', 40),
                    m.role, m.created_at
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE messages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![sanitized, limit], |row| {
            Ok(ChatSearchResult {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                content_snippet: row.get(3)?,
                role: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    })
}

/// Get lifetime token statistics.
#[tauri::command]
pub async fn get_token_stats(
    state: State<'_, AppState>,
) -> Result<TokenStatsRow, ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        let prompt: i64 = conn
            .query_row(
                "SELECT value FROM token_stats WHERE key = 'lifetime_prompt'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let completion: i64 = conn
            .query_row(
                "SELECT value FROM token_stats WHERE key = 'lifetime_completion'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(TokenStatsRow {
            lifetime_prompt: prompt,
            lifetime_completion: completion,
        })
    })
}

/// Increment token statistics by delta values.
#[tauri::command]
pub async fn update_token_stats(
    prompt_delta: i64,
    completion_delta: i64,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute(
            "UPDATE token_stats SET value = value + ?1 WHERE key = 'lifetime_prompt'",
            params![prompt_delta],
        )?;
        conn.execute(
            "UPDATE token_stats SET value = value + ?1 WHERE key = 'lifetime_completion'",
            params![completion_delta],
        )?;
        Ok(())
    })
}

/// Reset lifetime token counters to zero.
#[tauri::command]
pub async fn reset_lifetime_tokens(
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute(
            "UPDATE token_stats SET value = 0",
            [],
        )?;
        Ok(())
    })
}

/// Migrate chat data from legacy localStorage JSON into the database.
/// Called once on upgrade; the frontend should delete localStorage after success.
#[tauri::command]
pub async fn migrate_chat_from_json(
    json_string: String,
    state: State<'_, AppState>,
) -> Result<MigrateResult, ChatDbError> {
    // Parse the legacy JSON structure
    let data: serde_json::Value = serde_json::from_str(&json_string)
        .map_err(|e| ChatDbError::Db(format!("Invalid JSON: {}", e)))?;

    with_chat_db(&state.chat_db, |conn| {
        // Safety: unchecked_transaction is safe here because the chat_db mutex is held
        // for the entire scope via with_chat_db, preventing concurrent access.
        let tx = conn.unchecked_transaction()
            .map_err(|e| ChatDbError::Db(e.to_string()))?;

        let mut sessions_imported = 0usize;
        let mut messages_imported = 0usize;

        // Legacy format: { sessions: [...], messages: [...], currentSessionId, config, tokenStats }
        if let Some(sessions) = data.get("sessions").and_then(|v| v.as_array()) {
            for session in sessions {
                let id = session.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let title = session.get("title").and_then(|v| v.as_str()).unwrap_or("New Chat");
                let created_at = session.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
                let updated_at = session.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);

                if id.is_empty() {
                    continue;
                }

                // Skip if session already exists (idempotent migration)
                let exists: bool = tx
                    .query_row(
                        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
                        params![id],
                        |row| row.get::<_, i32>(0),
                    )
                    .unwrap_or(0) > 0;

                if exists {
                    continue;
                }

                tx.execute(
                    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![id, title, created_at, updated_at],
                ).map_err(|e| ChatDbError::Db(e.to_string()))?;
                sessions_imported += 1;

                // Import messages for this session
                if let Some(msgs) = session.get("messages").and_then(|v| v.as_array()) {
                    for (order, msg) in msgs.iter().enumerate() {
                        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        let reasoning = msg.get("reasoning").and_then(|v| v.as_str());
                        let images = msg.get("images").map(|v| v.to_string());
                        // Use session created_at as base + order for message timestamps
                        let msg_time = created_at + order as i64;

                        tx.execute(
                            "INSERT INTO messages (session_id, role, content, reasoning, images, created_at, sort_order)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![id, role, content, reasoning, images, msg_time, order as i64],
                        ).map_err(|e| ChatDbError::Db(e.to_string()))?;
                        messages_imported += 1;
                    }
                }
            }
        }

        // Migrate token stats
        if let Some(stats) = data.get("tokenStats") {
            let lp = stats.get("lifetimePrompt").and_then(|v| v.as_i64()).unwrap_or(0);
            let lc = stats.get("lifetimeCompletion").and_then(|v| v.as_i64()).unwrap_or(0);
            if lp > 0 || lc > 0 {
                tx.execute(
                    "UPDATE token_stats SET value = ?1 WHERE key = 'lifetime_prompt'",
                    params![lp],
                ).map_err(|e| ChatDbError::Db(e.to_string()))?;
                tx.execute(
                    "UPDATE token_stats SET value = ?1 WHERE key = 'lifetime_completion'",
                    params![lc],
                ).map_err(|e| ChatDbError::Db(e.to_string()))?;
            }
        }

        tx.commit().map_err(|e| ChatDbError::Db(e.to_string()))?;

        Ok(MigrateResult {
            sessions_imported,
            messages_imported,
        })
    })
}

/// Delete a single message by its database ID.
#[tauri::command]
pub async fn delete_chat_message(
    message_id: i64,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
        Ok(())
    })
}

/// Save a chat image from base64 data, returning the relative path.
/// Uses spawn_blocking to avoid holding the async runtime with I/O.
#[tauri::command]
pub async fn save_chat_image(
    session_id: String,
    data_base64: String,
    media_type: String,
    state: State<'_, AppState>,
) -> Result<String, ChatDbError> {
    // Validate session_id to prevent path traversal
    if !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(ChatDbError::Io("Invalid session_id".into()));
    }

    let vault = state.vault_path.read().clone();
    let vault = vault.ok_or(ChatDbError::NoVault)?;

    // Determine file extension from media type
    let ext = match media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    };
    let ext = ext.to_string();

    // Offload blocking I/O to a dedicated thread
    tokio::task::spawn_blocking(move || {
        let images_dir = vault.join(".oxidenote").join("chat_images").join(&session_id);
        std::fs::create_dir_all(&images_dir)?;

        // Unique filename: timestamp + random suffix (same pattern as trash.rs)
        let ts = chrono::Utc::now().timestamp_millis();
        let r: u32 = rand::random();
        let filename = format!("{}_{:08x}.{}", ts, r, ext);
        let file_path = images_dir.join(&filename);

        // Decode base64 and write to file
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data_base64)
            .map_err(|e| ChatDbError::Io(format!("Base64 decode failed: {}", e)))?;

        std::fs::write(&file_path, &bytes)?;

        // Return relative path from vault root
        let rel_path = format!(".oxidenote/chat_images/{}/{}", session_id, filename);
        Ok(rel_path)
    })
    .await
    .map_err(|e| ChatDbError::Io(format!("Task join failed: {}", e)))?
}

// ── AI Memory CRUD ──────────────────────────────────────────

/// A persistent AI memory entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMemory {
    pub id: i64,
    pub content: String,
    pub category: String,
    pub created_at: i64,
    pub pinned: bool,
}

/// List all AI memories, pinned first, then by recency.
#[tauri::command]
pub async fn list_ai_memories(
    state: State<'_, AppState>,
) -> Result<Vec<AiMemory>, ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, content, category, created_at, pinned
             FROM memories ORDER BY pinned DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AiMemory {
                id: row.get(0)?,
                content: row.get(1)?,
                category: row.get(2)?,
                created_at: row.get(3)?,
                pinned: row.get::<_, i32>(4)? != 0,
            })
        })?;
        let mut memories = Vec::new();
        for row in rows {
            memories.push(row?);
        }
        Ok(memories)
    })
}

/// Add a new AI memory entry.
#[tauri::command]
pub async fn add_ai_memory(
    content: String,
    category: String,
    state: State<'_, AppState>,
) -> Result<AiMemory, ChatDbError> {
    // Prevent unbounded memory entries that would bloat every system prompt
    if content.chars().count() > 1000 {
        return Err(ChatDbError::Db(
            "Memory content exceeds 1000 character limit".into(),
        ));
    }
    with_chat_db(&state.chat_db, |conn| {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO memories (content, category, created_at) VALUES (?1, ?2, ?3)",
            params![content, category, now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(AiMemory {
            id,
            content,
            category,
            created_at: now,
            pinned: false,
        })
    })
}

/// Delete an AI memory by ID.
#[tauri::command]
pub async fn delete_ai_memory(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Toggle pinned state of an AI memory.
#[tauri::command]
pub async fn toggle_ai_memory_pin(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), ChatDbError> {
    with_chat_db(&state.chat_db, |conn| {
        conn.execute(
            "UPDATE memories SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}
