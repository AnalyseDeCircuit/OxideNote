use serde::Serialize;
use tauri::State;

use crate::indexing::db;
use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("No vault opened")]
    NoVault,
    #[error("Index not available")]
    NoIndex,
    #[error("Search error: {0}")]
    Internal(String),
}

impl Serialize for SearchError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Full-text search across all indexed notes.
#[tauri::command]
pub async fn search_notes(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::search_fts(conn, &query).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Search notes by filename/title.
#[tauri::command]
pub async fn search_by_filename(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::SearchResult>, SearchError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    db::search_by_filename(conn, &query).map_err(|e| SearchError::Internal(e.to_string()))
}

/// Get all notes that link to the specified note path.
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::BacklinkResult>, SearchError> {
    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    // WikiLinks can reference either the full path or just the filename
    let file_stem = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path.clone());

    // Try both the relative path and the stem
    let mut results = db::get_backlinks(conn, &path)
        .map_err(|e| SearchError::Internal(e.to_string()))?;

    if file_stem != path {
        let by_stem = db::get_backlinks(conn, &file_stem)
            .map_err(|e| SearchError::Internal(e.to_string()))?;
        for r in by_stem {
            if !results.iter().any(|existing| existing.path == r.path) {
                results.push(r);
            }
        }
    }

    Ok(results)
}

/// Re-index a single note (called after saves).
#[tauri::command]
pub async fn reindex_note(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), SearchError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(SearchError::NoVault)?;
    let file_path = vault.join(&path);

    let db_guard = state.db.lock();
    let conn = db_guard.as_ref().ok_or(SearchError::NoIndex)?;

    if file_path.exists() {
        crate::indexing::scanner::index_single_file(vault, &file_path, conn)
            .map_err(SearchError::Internal)
    } else {
        crate::indexing::scanner::remove_from_index(vault, &file_path, conn)
            .map_err(SearchError::Internal)
    }
}
