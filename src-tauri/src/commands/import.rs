/**
 * Bulk import command — copy external .md files into the vault.
 *
 * Security: uses fs::copy for kernel-level streaming (no full-file memory load).
 * Only .md files are accepted. Source paths are external (not validated against vault),
 * but destination paths are validated to be inside the vault.
 */

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use super::util::{validate_path_inside_vault, PathValidationError};

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("No vault opened")]
    NoVault,
    #[error("Access denied: path outside vault")]
    AccessDenied,
    #[error("IO error: {0}")]
    Io(String),
}

impl Serialize for ImportError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<PathValidationError> for ImportError {
    fn from(e: PathValidationError) -> Self {
        match e {
            PathValidationError::AccessDenied => ImportError::AccessDenied,
            PathValidationError::Io(msg) => ImportError::Io(msg),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: Vec<String>,
}

/// Import multiple external .md files into the vault root (or a target subfolder).
/// Skips files that already exist in the destination. Returns count + skipped list.
#[tauri::command]
pub async fn bulk_import_notes(
    source_paths: Vec<String>,
    target_folder: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, ImportError> {
    let vault_path = state.vault_path.read().clone();
    let vault = vault_path.as_ref().ok_or(ImportError::NoVault)?;

    // Resolve and validate target directory inside vault
    let dest_dir = if target_folder.is_empty() {
        vault.to_path_buf()
    } else {
        validate_path_inside_vault(vault, &target_folder)?
    };

    // Ensure destination directory exists
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)
            .map_err(|e| ImportError::Io(e.to_string()))?;
    }

    let mut imported = 0;
    let mut skipped = Vec::new();

    for source in &source_paths {
        let source_path = Path::new(source);

        // Only accept supported note files (.md, .typ, .tex)
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if !super::util::is_supported_extension(ext) {
            skipped.push(format!("{} (unsupported extension)", source));
            continue;
        }

        let file_name = match source_path.file_name() {
            Some(n) => n,
            None => {
                skipped.push(format!("{} (invalid name)", source));
                continue;
            }
        };

        let dest_path = dest_dir.join(file_name);

        // Skip if file already exists (don't overwrite)
        if dest_path.exists() {
            skipped.push(format!("{} (already exists)", file_name.to_string_lossy()));
            continue;
        }

        // Use fs::copy for kernel-level streaming (no full-file memory load)
        match fs::copy(source_path, &dest_path) {
            Ok(_) => {
                imported += 1;
            }
            Err(e) => {
                skipped.push(format!("{} (copy error: {})", file_name.to_string_lossy(), e));
            }
        }
    }

    Ok(ImportResult { imported, skipped })
}
