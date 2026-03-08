/// Bookmarks — user-curated note favorites stored in SQLite.
///
/// Schema: `bookmarks (id, path UNIQUE, created_at, sort_order)`
/// Bookmarks survive re-indexing because they live in a separate table.

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum BookmarkError {
    #[error("No vault opened")]
    NoVault,
    #[error("No index available")]
    NoIndex,
    #[error("Database error: {0}")]
    Db(String),
    #[error("Bookmark already exists")]
    AlreadyExists,
}

impl Serialize for BookmarkError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── Data types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkEntry {
    pub path: String,
    pub created_at: String,
    pub sort_order: i32,
}

// ── Schema migration ────────────────────────────────────────

/// Create the bookmarks table if it doesn't exist.
/// Called during vault open (idempotent).
pub fn create_bookmarks_table(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────

/// Add a note to bookmarks.
#[tauri::command]
pub async fn add_bookmark(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), BookmarkError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(BookmarkError::NoIndex)?;

    // Determine next sort_order
    let max_order: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM bookmarks",
            [],
            |row| row.get(0),
        )
        .map_err(|e| BookmarkError::Db(e.to_string()))?;

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO bookmarks (path, created_at, sort_order) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, now, max_order + 1],
    )
    .map_err(|e| BookmarkError::Db(e.to_string()))?;

    Ok(())
}

/// Remove a note from bookmarks.
#[tauri::command]
pub async fn remove_bookmark(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), BookmarkError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(BookmarkError::NoIndex)?;

    conn.execute("DELETE FROM bookmarks WHERE path = ?1", rusqlite::params![path])
        .map_err(|e| BookmarkError::Db(e.to_string()))?;
    Ok(())
}

/// List all bookmarks, ordered by sort_order ascending.
#[tauri::command]
pub async fn list_bookmarks(
    state: State<'_, AppState>,
) -> Result<Vec<BookmarkEntry>, BookmarkError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(BookmarkError::NoIndex)?;

    // Ensure table exists (in case read_db was opened before migration)
    create_bookmarks_table(conn).map_err(|e| BookmarkError::Db(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT path, created_at, sort_order FROM bookmarks ORDER BY sort_order ASC")
        .map_err(|e| BookmarkError::Db(e.to_string()))?;

    let entries = stmt
        .query_map([], |row| {
            Ok(BookmarkEntry {
                path: row.get(0)?,
                created_at: row.get(1)?,
                sort_order: row.get(2)?,
            })
        })
        .map_err(|e| BookmarkError::Db(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

/// Reorder bookmarks by providing the new path order.
#[tauri::command]
pub async fn reorder_bookmarks(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), BookmarkError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(BookmarkError::NoIndex)?;

    for (i, path) in paths.iter().enumerate() {
        conn.execute(
            "UPDATE bookmarks SET sort_order = ?1 WHERE path = ?2",
            rusqlite::params![i as i32, path],
        )
        .map_err(|e| BookmarkError::Db(e.to_string()))?;
    }

    Ok(())
}

/// Check if a given note path is bookmarked.
#[tauri::command]
pub async fn is_bookmarked(
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, BookmarkError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(BookmarkError::NoIndex)?;

    let count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM bookmarks WHERE path = ?1",
            rusqlite::params![path],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(count > 0)
}
