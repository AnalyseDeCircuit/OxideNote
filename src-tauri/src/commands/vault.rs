use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("Directory does not exist: {0}")]
    NotFound(String),
    #[error("Directory is not readable: {0}")]
    NotReadable(String),
}

impl Serialize for VaultError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Open a vault at the given path. Validates that the directory exists and stores
/// the path in app state.
#[tauri::command]
pub async fn open_vault(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, VaultError> {
    let vault_path = PathBuf::from(&path);

    if !vault_path.exists() {
        return Err(VaultError::NotFound(path));
    }

    if !vault_path.is_dir() {
        return Err(VaultError::NotReadable(path));
    }

    tracing::info!("Opening vault at: {}", path);
    *state.vault_path.write() = Some(vault_path);

    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

/// List the vault directory tree. Returns top-level entries.
/// Directories get their immediate children populated (one level of lookahead).
#[tauri::command]
pub async fn list_tree(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<TreeNode>, VaultError> {
    let vault_path = state.vault_path.read();
    let base = vault_path
        .as_ref()
        .ok_or_else(|| VaultError::NotFound("No vault opened".into()))?;

    let target = if path.is_empty() {
        base.clone()
    } else {
        base.join(&path)
    };

    if !target.exists() || !target.is_dir() {
        return Err(VaultError::NotFound(path));
    }

    let mut entries = list_dir_entries(&target, base)?;
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

fn list_dir_entries(dir: &PathBuf, base: &PathBuf) -> Result<Vec<TreeNode>, VaultError> {
    let read_dir = std::fs::read_dir(dir)
        .map_err(|_| VaultError::NotReadable(dir.display().to_string()))?;

    let mut nodes = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs and common non-content directories
        if file_name.starts_with('.')
            || file_name == "node_modules"
            || file_name == "target"
        {
            continue;
        }

        let file_type = entry.file_type().unwrap();
        let is_dir = file_type.is_dir();

        // Only include .md files and directories
        if !is_dir && !file_name.ends_with(".md") {
            continue;
        }

        let rel_path = entry
            .path()
            .strip_prefix(base)
            .unwrap_or(&entry.path())
            .to_string_lossy()
            .to_string();

        let children = if is_dir {
            // One level lookahead for directories
            match list_dir_entries(&entry.path(), base) {
                Ok(mut c) => {
                    c.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                    });
                    Some(c)
                }
                Err(_) => Some(vec![]),
            }
        } else {
            None
        };

        nodes.push(TreeNode {
            name: file_name,
            path: rel_path,
            is_dir,
            children,
        });
    }

    Ok(nodes)
}
