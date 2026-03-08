/// Note version history — snapshot-based undo with content-hash dedup.
///
/// Storage layout:
///   `.oxidenote/history/{note-stem}/{unix_ms}_{sha256_8}.md`
///
/// Before each `write_note`, the old content is hashed. If no existing
/// snapshot shares that hash, a new snapshot is saved. This prevents
/// redundant snapshots when the user saves without changes.
///
/// Uses the `similar` crate for line-level diff computation.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use tauri::State;

use crate::state::AppState;

// ── Error type ──────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("No vault opened")]
    NoVault,
    #[error("IO error: {0}")]
    Io(String),
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("Snapshot not found: {0}")]
    NotFound(String),
}

impl Serialize for HistoryError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── Data types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    /// Snapshot filename (serves as unique ID)
    pub id: String,
    /// Unix epoch milliseconds when snapshot was created
    pub timestamp: i64,
    /// File size in bytes
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffChunk {
    /// "equal", "insert", or "delete"
    pub tag: String,
    /// The text content of this chunk
    pub value: String,
}

// ── Internal helpers ────────────────────────────────────────

/// Maximum number of snapshots to keep per note (oldest are pruned)
const MAX_SNAPSHOTS_PER_NOTE: usize = 50;

/// Compute the history directory for a given note path.
/// e.g. for "notes/ideas.md" → ".oxidenote/history/notes/ideas"
fn history_dir_for(vault: &Path, note_rel_path: &str) -> PathBuf {
    let stem = note_rel_path.strip_suffix(".md").unwrap_or(note_rel_path);
    vault.join(".oxidenote").join("history").join(stem)
}

/// Compute first 8 chars of SHA-256 hex digest of content.
fn content_hash_short(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    hex_encode(&digest[..4])
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Validate a relative path stays inside the vault.
fn validate_inside_vault(base: &Path, rel_path: &str) -> Result<PathBuf, HistoryError> {
    let full_path = base.join(rel_path);
    let canonical_base = base
        .canonicalize()
        .map_err(|e| HistoryError::Io(e.to_string()))?;

    if full_path.exists() {
        let canonical = full_path
            .canonicalize()
            .map_err(|e| HistoryError::Io(e.to_string()))?;
        if !canonical.starts_with(&canonical_base) {
            return Err(HistoryError::AccessDenied);
        }
        Ok(canonical)
    } else {
        if let Some(parent) = full_path.parent() {
            if parent.exists() {
                let canonical_parent = parent
                    .canonicalize()
                    .map_err(|e| HistoryError::Io(e.to_string()))?;
                if !canonical_parent.starts_with(&canonical_base) {
                    return Err(HistoryError::AccessDenied);
                }
            }
        }
        Ok(full_path)
    }
}

// ── Public API (called from write_note) ─────────────────────

/// Save a snapshot of the current note content before overwriting.
/// Skips if the content hash already exists among recent snapshots.
///
/// This function is called internally (not a Tauri command).
pub fn save_snapshot(vault: &Path, note_rel_path: &str, old_content: &str) -> Result<(), HistoryError> {
    if old_content.is_empty() {
        return Ok(());
    }

    let dir = history_dir_for(vault, note_rel_path);
    std::fs::create_dir_all(&dir).map_err(|e| HistoryError::Io(e.to_string()))?;

    let hash = content_hash_short(old_content);

    // Check if a snapshot with the same hash already exists (dedup)
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(&format!("_{}.md", hash)) {
                // Content unchanged since last snapshot — skip
                return Ok(());
            }
        }
    }

    // Write new snapshot
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let filename = format!("{}_{}.md", timestamp, hash);
    let snapshot_path = dir.join(&filename);
    std::fs::write(&snapshot_path, old_content)
        .map_err(|e| HistoryError::Io(e.to_string()))?;

    // Prune old snapshots if over the limit
    prune_snapshots(&dir);

    Ok(())
}

/// Remove oldest snapshots if more than MAX_SNAPSHOTS_PER_NOTE exist.
fn prune_snapshots(dir: &Path) {
    let mut snapshots: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext == "md")
        })
        .collect();

    if snapshots.len() <= MAX_SNAPSHOTS_PER_NOTE {
        return;
    }

    // Sort by filename (which starts with timestamp) — ascending
    snapshots.sort_by_key(|e| e.file_name());

    let to_remove = snapshots.len() - MAX_SNAPSHOTS_PER_NOTE;
    for entry in snapshots.into_iter().take(to_remove) {
        let _ = std::fs::remove_file(entry.path());
    }
}

// ── Tauri commands ──────────────────────────────────────────

/// List all history snapshots for a given note, newest first.
#[tauri::command]
pub async fn list_note_history(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, HistoryError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(HistoryError::NoVault)?;
    validate_inside_vault(vault, &path)?;

    let dir = history_dir_for(vault, &path);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<HistoryEntry> = std::fs::read_dir(&dir)
        .map_err(|e| HistoryError::Io(e.to_string()))?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                return None;
            }
            let meta = e.metadata().ok()?;
            // Parse timestamp from filename: {timestamp}_{hash}.md
            let ts_str = name.split('_').next()?;
            let timestamp: i64 = ts_str.parse().ok()?;
            Some(HistoryEntry {
                id: name,
                timestamp,
                size: meta.len(),
            })
        })
        .collect();

    // Newest first
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(entries)
}

/// Read a specific history snapshot's content.
#[tauri::command]
pub async fn read_history_snapshot(
    path: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<String, HistoryError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(HistoryError::NoVault)?;
    validate_inside_vault(vault, &path)?;

    let dir = history_dir_for(vault, &path);
    let snapshot_path = dir.join(&snapshot_id);

    // Prevent directory traversal via snapshot_id
    if !snapshot_path.starts_with(&dir) {
        return Err(HistoryError::AccessDenied);
    }

    std::fs::read_to_string(&snapshot_path)
        .map_err(|_| HistoryError::NotFound(snapshot_id))
}

/// Restore a snapshot: reads snapshot content and writes it as the current note.
#[tauri::command]
pub async fn restore_snapshot(
    path: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<(), HistoryError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(HistoryError::NoVault)?;
    let full_path = validate_inside_vault(vault, &path)?;

    let dir = history_dir_for(vault, &path);
    let snapshot_path = dir.join(&snapshot_id);

    if !snapshot_path.starts_with(&dir) {
        return Err(HistoryError::AccessDenied);
    }

    // Save current content as a snapshot before restoring
    if full_path.exists() {
        let current_content = std::fs::read_to_string(&full_path)
            .map_err(|e| HistoryError::Io(e.to_string()))?;
        save_snapshot(vault, &path, &current_content)?;
    }

    let snapshot_content = std::fs::read_to_string(&snapshot_path)
        .map_err(|_| HistoryError::NotFound(snapshot_id))?;

    // Atomic write: .tmp then rename
    let tmp_path = full_path.with_extension("md.tmp");
    std::fs::write(&tmp_path, &snapshot_content)
        .map_err(|e| HistoryError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &full_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        HistoryError::Io(e.to_string())
    })?;

    Ok(())
}

/// Compute line-level diff between a snapshot and the current note content.
#[tauri::command]
pub async fn diff_with_current(
    path: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DiffChunk>, HistoryError> {
    let vault_path = state.vault_path.read();
    let vault = vault_path.as_ref().ok_or(HistoryError::NoVault)?;
    let full_path = validate_inside_vault(vault, &path)?;

    let dir = history_dir_for(vault, &path);
    let snapshot_path = dir.join(&snapshot_id);

    if !snapshot_path.starts_with(&dir) {
        return Err(HistoryError::AccessDenied);
    }

    let old_content = std::fs::read_to_string(&snapshot_path)
        .map_err(|_| HistoryError::NotFound(snapshot_id))?;
    let current_content = std::fs::read_to_string(&full_path)
        .map_err(|e| HistoryError::Io(e.to_string()))?;

    let diff = TextDiff::from_lines(&old_content, &current_content);
    let chunks: Vec<DiffChunk> = diff
        .iter_all_changes()
        .map(|change| {
            let tag = match change.tag() {
                ChangeTag::Equal => "equal",
                ChangeTag::Insert => "insert",
                ChangeTag::Delete => "delete",
            };
            DiffChunk {
                tag: tag.to_string(),
                value: change.value().to_string(),
            }
        })
        .collect();

    Ok(chunks)
}
