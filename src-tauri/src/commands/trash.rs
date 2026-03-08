/// Application-level trash (soft delete) with manifest-based tracking.
///
/// Deleted notes are moved to `.oxidenote/trash/` and recorded in
/// `trash_manifest.json` with their original path and deletion timestamp.
/// On startup, entries older than 30 days are automatically purged.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum TrashError {
    #[error("No vault opened")]
    NoVault,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("Item not found in trash: {0}")]
    NotFound(String),
    #[error("Restore conflict: target path already exists")]
    RestoreConflict,
}

impl Serialize for TrashError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── Data types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    /// Unique id (UUID-style) for this trash item
    pub id: String,
    /// Original path relative to vault root
    pub original_path: String,
    /// Path inside .oxidenote/trash/ (relative to vault root)
    pub trash_path: String,
    /// Unix epoch milliseconds when deleted
    pub deleted_at: i64,
    /// File size in bytes (0 for directories)
    pub size: u64,
    /// Whether this entry is a directory
    pub is_dir: bool,
}

/// How long trash items are kept before auto-purge (30 days in ms)
const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

// ── Internal helpers ────────────────────────────────────────

fn trash_dir(vault: &Path) -> PathBuf {
    vault.join(".oxidenote").join("trash")
}

fn manifest_path(vault: &Path) -> PathBuf {
    vault.join(".oxidenote").join("trash_manifest.json")
}

fn read_manifest(vault: &Path) -> Vec<TrashEntry> {
    let path = manifest_path(vault);
    if !path.exists() {
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(vault: &Path, entries: &[TrashEntry]) -> Result<(), TrashError> {
    let path = manifest_path(vault);
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| TrashError::Io(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| TrashError::Io(e.to_string()))?;
    Ok(())
}

fn validate_inside_vault(base: &Path, rel_path: &str) -> Result<PathBuf, TrashError> {
    let full_path = base.join(rel_path);
    let canonical_base = base
        .canonicalize()
        .map_err(|e| TrashError::Io(e.to_string()))?;

    if full_path.exists() {
        let canonical = full_path
            .canonicalize()
            .map_err(|e| TrashError::Io(e.to_string()))?;
        if !canonical.starts_with(&canonical_base) {
            return Err(TrashError::AccessDenied);
        }
        Ok(canonical)
    } else {
        Ok(full_path)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn generate_id() -> String {
    // Simple unique id: timestamp + random suffix
    let ts = now_ms();
    let r: u32 = rand::random();
    format!("{}_{:08x}", ts, r)
}

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

// ── Startup cleanup ─────────────────────────────────────────

/// Run on application startup to purge trash items older than 30 days.
/// Called from vault open logic (non-blocking).
pub fn cleanup_expired_trash(vault: &Path) {
    let mut entries = read_manifest(vault);
    let cutoff = now_ms() - TRASH_RETENTION_MS;
    let mut changed = false;

    entries.retain(|entry| {
        if entry.deleted_at < cutoff {
            // Permanently delete the file/dir from trash
            let trash_full = vault.join(&entry.trash_path);
            if trash_full.is_dir() {
                let _ = std::fs::remove_dir_all(&trash_full);
            } else {
                let _ = std::fs::remove_file(&trash_full);
            }
            changed = true;
            false // remove from manifest
        } else {
            true // keep
        }
    });

    if changed {
        let _ = write_manifest(vault, &entries);
        tracing::info!("Trash cleanup: removed expired items");
    }
}

// ── Tauri commands ──────────────────────────────────────────

/// Move a file or directory to the application trash.
/// Called instead of the old system trash::delete().
#[tauri::command]
pub async fn soft_delete(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), TrashError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(TrashError::NoVault)?;
    let full_path = validate_inside_vault(vault, &path)?;

    if !full_path.exists() {
        return Err(TrashError::NotFound(path));
    }

    // Prevent deleting vault root
    let canonical_base = vault
        .canonicalize()
        .map_err(|e| TrashError::Io(e.to_string()))?;
    if full_path == canonical_base {
        return Err(TrashError::Io("Cannot delete vault root".into()));
    }

    let is_dir = full_path.is_dir();
    let size = if is_dir {
        dir_size(&full_path)
    } else {
        full_path.metadata().map(|m| m.len()).unwrap_or(0)
    };

    // Generate unique trash sub-path to avoid collisions
    let id = generate_id();
    let trash_sub = format!(".oxidenote/trash/{}/{}", id, path);
    let trash_full = vault.join(&trash_sub);

    // Create parent directories in trash
    if let Some(parent) = trash_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| TrashError::Io(e.to_string()))?;
    }

    // Move file/directory to trash
    std::fs::rename(&full_path, &trash_full)
        .map_err(|e| TrashError::Io(format!("Move to trash failed: {}", e)))?;

    // Update manifest
    let mut manifest = read_manifest(vault);
    manifest.push(TrashEntry {
        id,
        original_path: path.clone(),
        trash_path: trash_sub,
        deleted_at: now_ms(),
        size,
        is_dir,
    });
    write_manifest(vault, &manifest)?;

    tracing::info!("Soft-deleted: {}", path);
    Ok(())
}

/// List all items currently in the application trash.
#[tauri::command]
pub async fn list_trash(
    state: State<'_, AppState>,
) -> Result<Vec<TrashEntry>, TrashError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(TrashError::NoVault)?;
    let mut entries = read_manifest(vault);
    // Newest first
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// Restore a trash item to its original location.
#[tauri::command]
pub async fn restore_from_trash(
    trash_id: String,
    state: State<'_, AppState>,
) -> Result<String, TrashError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(TrashError::NoVault)?;

    let mut manifest = read_manifest(vault);
    let idx = manifest
        .iter()
        .position(|e| e.id == trash_id)
        .ok_or_else(|| TrashError::NotFound(trash_id.clone()))?;

    let entry = manifest[idx].clone();
    let trash_full = vault.join(&entry.trash_path);
    let restore_full = vault.join(&entry.original_path);

    // Check restore target doesn't already exist
    if restore_full.exists() {
        return Err(TrashError::RestoreConflict);
    }

    // Create parent dirs for restore target
    if let Some(parent) = restore_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| TrashError::Io(e.to_string()))?;
    }

    // Move back
    std::fs::rename(&trash_full, &restore_full)
        .map_err(|e| TrashError::Io(format!("Restore failed: {}", e)))?;

    // Clean up empty trash subdirectory
    if let Some(parent) = trash_full.parent() {
        let _ = std::fs::remove_dir(parent);
    }

    manifest.remove(idx);
    write_manifest(vault, &manifest)?;

    tracing::info!("Restored from trash: {}", entry.original_path);
    Ok(entry.original_path)
}

/// Permanently delete a single item from the trash.
#[tauri::command]
pub async fn permanent_delete(
    trash_id: String,
    state: State<'_, AppState>,
) -> Result<(), TrashError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(TrashError::NoVault)?;

    let mut manifest = read_manifest(vault);
    let idx = manifest
        .iter()
        .position(|e| e.id == trash_id)
        .ok_or_else(|| TrashError::NotFound(trash_id.clone()))?;

    let entry = manifest.remove(idx);
    let trash_full = vault.join(&entry.trash_path);

    if trash_full.is_dir() {
        std::fs::remove_dir_all(&trash_full)
            .map_err(|e| TrashError::Io(e.to_string()))?;
    } else {
        std::fs::remove_file(&trash_full)
            .map_err(|e| TrashError::Io(e.to_string()))?;
    }

    // Clean up empty parent directory
    if let Some(parent) = trash_full.parent() {
        let _ = std::fs::remove_dir(parent);
    }

    write_manifest(vault, &manifest)?;
    tracing::info!("Permanently deleted from trash: {}", trash_id);
    Ok(())
}

/// Empty the entire trash (permanently delete all items).
#[tauri::command]
pub async fn empty_trash(
    state: State<'_, AppState>,
) -> Result<(), TrashError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(TrashError::NoVault)?;

    let trash = trash_dir(vault);
    if trash.exists() {
        std::fs::remove_dir_all(&trash)
            .map_err(|e| TrashError::Io(e.to_string()))?;
    }

    // Clear manifest
    write_manifest(vault, &[])?;
    tracing::info!("Trash emptied");
    Ok(())
}
