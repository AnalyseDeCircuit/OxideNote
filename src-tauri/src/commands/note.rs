use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum NoteError {
    #[error("No vault opened")]
    NoVault,
    #[error("Note not found: {0}")]
    NotFound(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Access denied: path outside vault")]
    AccessDenied,
}

impl Serialize for NoteError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteContent {
    pub path: String,
    pub content: String,
}

/// Validate that a resolved path is within the vault root.
/// Returns the canonical full path if valid.
fn validate_inside_vault(base: &Path, rel_path: &str) -> Result<PathBuf, NoteError> {
    let full_path = base.join(rel_path);
    let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
    // For new files that don't exist yet, canonicalize the parent
    if full_path.exists() {
        let canonical_target = full_path.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err(NoteError::AccessDenied);
        }
        Ok(canonical_target)
    } else {
        // For paths that don't exist yet, canonicalize the parent dir
        let parent = full_path.parent().ok_or_else(|| NoteError::Io("Invalid path".into()))?;
        let canonical_parent = parent.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(NoteError::AccessDenied);
        }
        Ok(full_path)
    }
}

/// Read a note's content by its vault-relative path.
#[tauri::command]
pub async fn read_note(
    path: String,
    state: State<'_, AppState>,
) -> Result<NoteContent, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;
    let full_path = validate_inside_vault(base, &path)?;

    if !full_path.exists() || !full_path.is_file() {
        return Err(NoteError::NotFound(path));
    }

    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    Ok(NoteContent { path, content })
}

/// Write note content. Uses atomic write (write to .tmp then rename).
#[tauri::command]
pub async fn write_note(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;
    // For write, the file may not exist yet. Validate parent is inside vault.
    let full_path = base.join(&path);
    {
        let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
            let canonical_parent = parent.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err(NoteError::AccessDenied);
            }
        }
    }

    // Atomic write: write to .tmp then rename
    let tmp_path = full_path.with_extension("md.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| NoteError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &full_path)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    tracing::debug!("Saved note: {}", path);
    Ok(())
}

/// Create a new note with optional default content.
#[tauri::command]
pub async fn create_note(
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;

    let file_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };

    let rel = if parent_path.is_empty() {
        file_name.clone()
    } else {
        format!("{}/{}", parent_path, file_name)
    };
    let full_path = validate_inside_vault(base, &rel)?;

    if full_path.exists() {
        return Err(NoteError::Io(format!("File already exists: {}", file_name)));
    }

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| NoteError::Io(e.to_string()))?;
    }

    let default_content = format!("---\ntitle: {}\ncreated: {}\n---\n\n", 
        name.trim_end_matches(".md"),
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    std::fs::write(&full_path, &default_content)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    let rel_path = full_path
        .strip_prefix(base)
        .unwrap_or(&full_path)
        .to_string_lossy()
        .to_string();

    tracing::info!("Created note: {}", rel_path);
    Ok(rel_path)
}

/// Create a new folder in the vault.
#[tauri::command]
pub async fn create_folder(
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;

    let rel = if parent_path.is_empty() {
        name.clone()
    } else {
        format!("{}/{}", parent_path, name)
    };
    // For new dirs, validate parent is inside vault
    let full_path = base.join(&rel);
    {
        let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        let parent = full_path.parent().ok_or_else(|| NoteError::Io("Invalid path".into()))?;
        // Ensure parent exists so we can canonicalize it
        std::fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
        let canonical_parent = parent.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(NoteError::AccessDenied);
        }
    }

    if full_path.exists() {
        return Err(NoteError::Io(format!("Folder already exists: {}", name)));
    }

    std::fs::create_dir_all(&full_path)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    let rel_path = full_path
        .strip_prefix(base)
        .unwrap_or(&full_path)
        .to_string_lossy()
        .to_string();

    tracing::info!("Created folder: {}", rel_path);
    Ok(rel_path)
}

/// Rename a file or folder.
#[tauri::command]
pub async fn rename_entry(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;

    let old_full = validate_inside_vault(base, &old_path)?;
    if !old_full.exists() {
        return Err(NoteError::NotFound(old_path));
    }

    let new_full = old_full
        .parent()
        .unwrap_or(base)
        .join(&new_name);

    // Validate new path is also inside vault
    {
        let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        let canonical_parent = new_full.parent()
            .ok_or_else(|| NoteError::Io("Invalid path".into()))?
            .canonicalize()
            .map_err(|e| NoteError::Io(e.to_string()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(NoteError::AccessDenied);
        }
    }

    if new_full.exists() {
        return Err(NoteError::Io(format!("Already exists: {}", new_name)));
    }

    std::fs::rename(&old_full, &new_full)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    let rel_path = new_full
        .strip_prefix(base)
        .unwrap_or(&new_full)
        .to_string_lossy()
        .to_string();

    tracing::info!("Renamed {} -> {}", old_path, rel_path);
    Ok(rel_path)
}

/// Delete a file or folder (moves to system trash).
#[tauri::command]
pub async fn delete_entry(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;
    let full_path = validate_inside_vault(base, &path)?;

    if !full_path.exists() {
        return Err(NoteError::NotFound(path));
    }

    // Prevent deleting the vault root
    let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
    if full_path == canonical_base {
        return Err(NoteError::Io("Cannot delete vault root".into()));
    }

    trash::delete(&full_path)
        .map_err(|e| NoteError::Io(format!("Trash failed: {}", e)))?;

    tracing::info!("Deleted: {}", path);
    Ok(())
}
