/**
 * Shared utilities for command modules.
 *
 * Contains path validation logic used across multiple command modules
 * to prevent code duplication while maintaining module-specific error types.
 */

use std::path::{Path, PathBuf};

/// Validate that a resolved path is within the vault root.
/// Returns the canonical full path if valid.
///
/// For existing paths: canonicalize and verify they're inside vault.
/// For non-existing paths: canonicalize the parent directory to prevent directory traversal.
///
/// Callers should map the returned error variants to their module-specific error type.
pub fn validate_path_inside_vault(base: &Path, rel_path: &str) -> Result<PathBuf, PathValidationError> {
    let full_path = base.join(rel_path);
    let canonical_base = base.canonicalize().map_err(|e| PathValidationError::Io(e.to_string()))?;

    if full_path.exists() {
        let canonical_target = full_path.canonicalize().map_err(|e| PathValidationError::Io(e.to_string()))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err(PathValidationError::AccessDenied);
        }
        Ok(canonical_target)
    } else {
        // For paths that don't exist yet, canonicalize the parent dir
        let parent = full_path.parent().ok_or_else(|| PathValidationError::Io("Invalid path".into()))?;
        let canonical_parent = parent.canonicalize().map_err(|e| PathValidationError::Io(e.to_string()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(PathValidationError::AccessDenied);
        }
        Ok(full_path)
    }
}

/// Atomic file write: writes content to a temporary file, then renames it
/// over the target path. Prevents data loss from crashes during write.
pub fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, content)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[derive(Debug)]
pub enum PathValidationError {
    AccessDenied,
    Io(String),
}
