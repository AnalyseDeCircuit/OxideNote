//! Vault statistics for the dashboard panel.

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum StatsError {
    #[error("No vault opened")]
    NoVault,
    #[error("Index not available")]
    NoIndex,
    #[error("Stats error: {0}")]
    Internal(String),
}

impl Serialize for StatsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ── Data structures ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct VaultStats {
    pub total_notes: u64,
    pub total_tags: u64,
    pub total_links: u64,
    pub orphan_notes: u64,
    pub recent_notes: Vec<RecentNote>,
    pub top_tags: Vec<TagCount>,
    pub daily_activity: Vec<DayActivity>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentNote {
    pub path: String,
    pub title: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayActivity {
    pub date: String,
    pub count: u64,
}

// ── Command ─────────────────────────────────────────────────

/// Gather vault statistics from the SQLite index.
#[tauri::command]
pub async fn get_vault_stats(
    state: State<'_, AppState>,
) -> Result<VaultStats, StatsError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(StatsError::NoIndex)?;

    // Total notes
    let total_notes: u64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    // Total distinct tags
    let total_tags: u64 = conn
        .query_row("SELECT COUNT(DISTINCT tag) FROM tags", [], |r| r.get(0))
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    // Total links
    let total_links: u64 = conn
        .query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    // Orphan notes: notes with no outgoing or incoming links
    let orphan_notes: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes
             WHERE id NOT IN (SELECT source_id FROM links)
               AND path NOT IN (SELECT target_path FROM links)
               AND id NOT IN (
                 SELECT n2.id FROM notes n2
                 JOIN links l2 ON l2.target_path = replace(replace(replace(
                   replace(n2.path, rtrim(n2.path, replace(n2.path, '/', '')), ''),
                   '.md', ''), '.typ', ''), '.tex', '')
               )",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Recent notes (top 10 by modified_at)
    let mut recent_stmt = conn
        .prepare(
            "SELECT path, title, modified_at FROM notes
             WHERE modified_at IS NOT NULL
             ORDER BY modified_at DESC LIMIT 10",
        )
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    let recent_notes: Vec<RecentNote> = recent_stmt
        .query_map([], |row| {
            Ok(RecentNote {
                path: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                modified_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })
        .map_err(|e| StatsError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    // Top tags (top 10 by frequency)
    let mut tag_stmt = conn
        .prepare(
            "SELECT tag, COUNT(*) as cnt FROM tags
             GROUP BY tag ORDER BY cnt DESC LIMIT 10",
        )
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    let top_tags: Vec<TagCount> = tag_stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| StatsError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    // Daily activity for the last 30 days
    let mut activity_stmt = conn
        .prepare(
            "SELECT DATE(modified_at) as d, COUNT(*) as cnt FROM notes
             WHERE modified_at IS NOT NULL
               AND modified_at >= DATE('now', '-30 days')
             GROUP BY d
             ORDER BY d ASC",
        )
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    let daily_activity: Vec<DayActivity> = activity_stmt
        .query_map([], |row| {
            Ok(DayActivity {
                date: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: row.get(1)?,
            })
        })
        .map_err(|e| StatsError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(VaultStats {
        total_notes,
        total_tags,
        total_links,
        orphan_notes,
        recent_notes,
        top_tags,
        daily_activity,
    })
}

/// List all notes with basic metadata for card flow view.
/// Sorted by modified_at descending, with optional limit/offset for pagination.
#[tauri::command]
pub async fn list_notes_summary(
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<RecentNote>, StatsError> {
    let db_guard = state.read_db.lock();
    let conn = db_guard.as_ref().ok_or(StatsError::NoIndex)?;

    let lim = limit.unwrap_or(50).min(200);
    let off = offset.unwrap_or(0);

    let mut stmt = conn
        .prepare(
            "SELECT path, title, modified_at FROM notes
             WHERE modified_at IS NOT NULL
             ORDER BY modified_at DESC
             LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| StatsError::Internal(e.to_string()))?;

    let notes: Vec<RecentNote> = stmt
        .query_map([lim, off], |row| {
            Ok(RecentNote {
                path: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                modified_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })
        .map_err(|e| StatsError::Internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(notes)
}
