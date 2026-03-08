use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, State};

use crate::state::AppState;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("Directory does not exist: {0}")]
    NotFound(String),
    #[error("Directory is not readable: {0}")]
    NotReadable(String),
    #[error("Index error: {0}")]
    IndexError(String),
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
    app_handle: tauri::AppHandle,
) -> Result<String, VaultError> {
    let vault_path = PathBuf::from(&path);

    if !vault_path.exists() {
        return Err(VaultError::NotFound(path));
    }

    if !vault_path.is_dir() {
        return Err(VaultError::NotReadable(path));
    }

    tracing::info!("Opening vault at: {}", path);

    // 切换 vault 前先停掉旧 watcher，防止旧 watcher 持有新 DB 连接导致跨 vault 幽灵索引
    *state.watcher.lock() = None;

    *state.vault_path.write() = Some(vault_path.clone());

    // Initialize index database (write connection)
    match crate::indexing::db::open_db(&vault_path) {
        Ok(conn) => {
            *state.db.lock() = Some(conn);

            // Open a second connection for read-only queries (avoids blocking writes)
            match crate::indexing::db::open_db(&vault_path) {
                Ok(read_conn) => {
                    *state.read_db.lock() = Some(read_conn);
                }
                Err(e) => {
                    // 读连接打开失败时，回退共享写连接，确保搜索/反链/图谱仍可用
                    tracing::warn!("Failed to open read connection, falling back to write conn: {}", e);
                    *state.read_db.lock() = Some(
                        crate::indexing::db::open_db(&vault_path)
                            .unwrap_or_else(|_| {
                                // 极端情况：连第三次打开都失败，则无法 fallback
                                // read_db 保持 None，后续读命令会返回 NoIndex
                                panic!("Cannot open any DB connection for vault");
                            })
                    );
                }
            }

            tracing::info!("Index database initialized (read+write connections)");

            // 后台扫描：从 Mutex 中取出连接直接传递给后台任务，
            // 避免整个扫描期间持锁阻塞 watcher 增量索引
            let scan_conn = state.db.lock().take();
            let db_arc = state.db.clone();
            let vault_clone = vault_path.clone();
            let handle = app_handle.clone();
            tokio::task::spawn_blocking(move || {
                if let Some(conn) = scan_conn {
                    if let Err(e) = crate::indexing::scanner::scan_vault(&vault_clone, &conn) {
                        tracing::warn!("Vault scan failed: {}", e);
                    } else {
                        tracing::info!("Vault scan completed");
                    }
                    // 扫描完毕，将连接放回 Mutex 供后续写操作使用
                    *db_arc.lock() = Some(conn);
                }
                let _ = handle.emit("vault:index-ready", ());
            });
        }
        Err(e) => {
            tracing::error!("Failed to open index database: {}", e);
            return Err(VaultError::IndexError(format!("Failed to open index: {}", e)));
        }
    }

    // Start file system watcher (with incremental indexing)
    let db_arc = state.db.clone();
    if let Ok(debouncer) = crate::watcher::start_watcher(&vault_path, app_handle.clone(), db_arc) {
        *state.watcher.lock() = Some(debouncer);
        tracing::info!("File watcher started for vault");
    } else {
        tracing::warn!("Failed to start file watcher");
    }

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
/// `sort_by` can be "name" (default) or "modified" (by modification time, newest first).
#[tauri::command]
pub async fn list_tree(
    path: String,
    sort_by: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<TreeNode>, VaultError> {
    let sort_mode = sort_by.unwrap_or_default();
    let vault_path = state.vault_path.read();
    let base = vault_path
        .as_ref()
        .ok_or_else(|| VaultError::NotFound("No vault opened".into()))?;

    let target = if path.is_empty() {
        base.clone()
    } else {
        let joined = base.join(&path);
        // Validate the listed path is inside vault
        let canonical_base = base.canonicalize()
            .map_err(|_| VaultError::NotReadable("Cannot resolve vault path".into()))?;
        let canonical_target = joined.canonicalize()
            .map_err(|_| VaultError::NotFound(path.clone()))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err(VaultError::NotFound("Access denied".into()));
        }
        joined
    };

    if !target.exists() || !target.is_dir() {
        return Err(VaultError::NotFound(path));
    }

    let entries = list_dir_entries(&target, base, &sort_mode)?;

    Ok(entries)
}

fn list_dir_entries(dir: &Path, base: &Path, sort_mode: &str) -> Result<Vec<TreeNode>, VaultError> {
    let read_dir = std::fs::read_dir(dir)
        .map_err(|_| VaultError::NotReadable(dir.display().to_string()))?;

    let mut items: Vec<(TreeNode, std::time::SystemTime)> = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs and common non-content directories
        if file_name.starts_with('.')
            || file_name == "node_modules"
            || file_name == "target"
        {
            continue;
        }

        // entry.file_type() can fail on broken symlinks or permission issues —
        // skip gracefully instead of panicking.
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();

        // Only include .md files and directories
        if !is_dir && !file_name.ends_with(".md") {
            continue;
        }

        let mtime = entry.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);

        let rel_path = entry
            .path()
            .strip_prefix(base)
            .unwrap_or(&entry.path())
            .to_string_lossy()
            .to_string();

        let children = if is_dir {
            // One level lookahead for directories
            match list_dir_entries(&entry.path(), base, sort_mode) {
                Ok(c) => Some(c),
                Err(_) => Some(vec![]),
            }
        } else {
            None
        };

        items.push((TreeNode {
            name: file_name,
            path: rel_path,
            is_dir,
            children,
        }, mtime));
    }

    // Sort: folders first, then by sort mode
    items.sort_by(|(a, a_time), (b, b_time)| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => {
            if sort_mode == "modified" {
                b_time.cmp(a_time) // newest first
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        }
    });

    Ok(items.into_iter().map(|(node, _)| node).collect())
}
