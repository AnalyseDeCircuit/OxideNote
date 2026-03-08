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
    #[error("CONFLICT: file was modified externally")]
    Conflict,
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
    /// File modification time as Unix epoch milliseconds.
    /// Used by the frontend to detect external modifications before saving.
    pub modified_at_ms: Option<i64>,
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

/// Get file modification time as epoch milliseconds.
fn get_mtime_ms(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
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

    let modified_at_ms = get_mtime_ms(&full_path);

    Ok(NoteContent { path, content, modified_at_ms })
}

/// Write note content. Uses atomic write (write to .tmp then rename).
/// If `expected_modified_at_ms` is provided, the current file mtime is checked first.
/// A mismatch means the file was modified externally → returns `NoteError::Conflict`.
#[tauri::command]
pub async fn write_note(
    path: String,
    content: String,
    expected_modified_at_ms: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Option<i64>, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;
    // For write, the file may not exist yet. Validate parent is inside vault.
    let full_path = base.join(&path);
    {
        let canonical_base = base.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
        // 在任何文件系统写操作之前，先拒绝包含 .. 的路径遍历
        if Path::new(&path).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(NoteError::AccessDenied);
        }
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
            let canonical_parent = parent.canonicalize().map_err(|e| NoteError::Io(e.to_string()))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err(NoteError::AccessDenied);
            }
        }
    }

    // Conflict detection: compare expected mtime with current mtime
    if let Some(expected) = expected_modified_at_ms {
        if full_path.exists() {
            if let Some(current) = get_mtime_ms(&full_path) {
                if current != expected {
                    return Err(NoteError::Conflict);
                }
            }
        }
    }

    // Atomic write: write to .tmp then rename
    let tmp_path = full_path.with_extension("md.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| NoteError::Io(e.to_string()))?;
    if let Err(e) = std::fs::rename(&tmp_path, &full_path) {
        // rename 失败时清理临时文件，防止 .tmp 文件累积
        let _ = std::fs::remove_file(&tmp_path);
        return Err(NoteError::Io(e.to_string()));
    }

    // 返回写入后的 mtime，让前端直接使用而无需额外 readNote 调用
    let new_mtime = get_mtime_ms(&full_path);
    tracing::debug!("Saved note: {} (mtime={:?})", path, new_mtime);
    Ok(new_mtime)
}

/// Create a new note with optional default content.
#[tauri::command]
pub async fn create_note(
    parent_path: String,
    name: String,
    template: Option<String>,
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

    let default_content = if let Some(tmpl) = template {
        tmpl.replace("{{title}}", name.trim_end_matches(".md"))
            .replace("{{date}}", &chrono::Local::now().format("%Y-%m-%d").to_string())
            .replace("{{datetime}}", &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
    } else {
        format!("---\ntitle: {}\ncreated: {}\n---\n\n", 
            name.trim_end_matches(".md"),
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        )
    };
    // 原子写入：先写 .tmp 再 rename，与 write_note 保持一致
    let tmp_path = full_path.with_extension("md.tmp");
    std::fs::write(&tmp_path, &default_content)
        .map_err(|e| NoteError::Io(e.to_string()))?;
    std::fs::rename(&tmp_path, &full_path)
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
        // 在任何文件系统写操作之前，先拒绝包含 .. 的路径遍历
        if Path::new(&rel).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(NoteError::AccessDenied);
        }
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

/// 移动文件或文件夹到新的父目录
///
/// 用于侧栏拖拽排列功能。移动前会验证源路径和目标路径
/// 都在 vault 目录范围内，防止路径穿越攻击。
#[tauri::command]
pub async fn move_entry(
    source_path: String,
    target_dir: String,
    state: State<'_, AppState>,
) -> Result<String, NoteError> {
    let vault_path = state.vault_path.read();
    let base = vault_path.as_ref().ok_or(NoteError::NoVault)?;

    let source_full = validate_inside_vault(base, &source_path)?;
    if !source_full.exists() {
        return Err(NoteError::NotFound(source_path));
    }

    // 目标目录：空字符串表示 vault 根目录
    let target_parent = if target_dir.is_empty() {
        base.clone()
    } else {
        let validated = validate_inside_vault(base, &target_dir)?;
        if !validated.is_dir() {
            return Err(NoteError::Io("Target is not a directory".into()));
        }
        validated
    };

    let file_name = source_full
        .file_name()
        .ok_or_else(|| NoteError::Io("Invalid source path".into()))?;
    let dest = target_parent.join(file_name);

    if dest.exists() {
        return Err(NoteError::Io(format!(
            "Already exists: {}",
            file_name.to_string_lossy()
        )));
    }

    std::fs::rename(&source_full, &dest)
        .map_err(|e| NoteError::Io(e.to_string()))?;

    let rel_path = dest
        .strip_prefix(base)
        .unwrap_or(&dest)
        .to_string_lossy()
        .to_string();

    tracing::info!("Moved {} -> {}", source_path, rel_path);
    Ok(rel_path)
}
