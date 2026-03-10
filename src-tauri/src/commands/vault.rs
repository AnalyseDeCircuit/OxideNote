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

    // Abort any running agent and scheduler from the previous vault to prevent
    // stale operations after the vault switch
    {
        let agent_state = &state.agent_state;
        // Abort running agent
        let mut run_state = agent_state.run_state.lock();
        if let crate::agent::commands::AgentRunState::Running { abort_tx, .. } = &*run_state {
            let _ = abort_tx.send(true);
        }
        *run_state = crate::agent::commands::AgentRunState::Idle;
        // Clear queued tasks from old vault
        agent_state.task_queue.lock().clear();
        // Abort old scheduler
        if let Some(handle) = agent_state.scheduler_handle.lock().take() {
            handle.abort();
        }
    }

    // Initialize index database (write connection)
    // 先打开所有 DB 连接再更新 vault_path，保证状态原子性：
    // 若 DB 打开失败，vault_path 不会被更新为指向无 DB 的路径
    let conn = crate::indexing::db::open_db(&vault_path)
        .map_err(|e| {
            tracing::error!("Failed to open index database: {}", e);
            VaultError::IndexError(format!("Failed to open index: {}", e))
        })?;

    // Open a second connection for read-only queries (avoids blocking writes)
    let read_conn = match crate::indexing::db::open_db(&vault_path) {
        Ok(rc) => Some(rc),
        Err(e) => {
            // 读连接打开失败时，尝试再次打开；若仍失败则 read_db 保持 None，
            // 后续读命令（搜索/反链/图谱）会返回 NoIndex 错误，不会崩溃
            tracing::warn!("Failed to open read connection, attempting fallback: {}", e);
            match crate::indexing::db::open_db(&vault_path) {
                Ok(fallback_conn) => Some(fallback_conn),
                Err(e2) => {
                    tracing::error!("Fallback read connection also failed: {}. Search/backlinks will be unavailable.", e2);
                    None
                }
            }
        }
    };

    // DB 连接全部就绪后，再原子地更新 state
    *state.vault_path.write() = Some(vault_path.clone());
    *state.db.lock() = Some(conn);
    *state.read_db.lock() = read_conn;

    // Open chat persistence database (separate from index.db)
    match crate::commands::chat_db::open_chat_db(&vault_path) {
        Ok(chat_conn) => {
            *state.chat_db.lock() = Some(chat_conn);
            tracing::info!("Chat database initialized");
        }
        Err(e) => {
            tracing::warn!("Failed to open chat database: {}. Chat persistence will be unavailable.", e);
        }
    }

    tracing::info!("Index database initialized (read+write connections)");

    // Background scan + watcher start: take the DB connection for scanning,
    // then start the watcher AFTER scan completes and connection is restored
    {
        let scan_conn = state.db.lock().take();
        let db_arc = state.db.clone();
        let watcher_arc = state.watcher.clone();
        let vault_clone = vault_path.clone();
        let vault_for_watcher = vault_path.clone();
        let handle = app_handle.clone();
        let handle_for_watcher = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(conn) = scan_conn {
                if let Err(e) = crate::indexing::scanner::scan_vault(&vault_clone, &conn) {
                    tracing::warn!("Vault scan failed: {}", e);
                } else {
                    tracing::info!("Vault scan completed");
                }
                // Return connection to Mutex for subsequent write operations
                *db_arc.lock() = Some(conn);
            }
            let _ = handle.emit("vault:index-ready", ());

            // Start file watcher AFTER scan completes and DB connection is restored
            let watcher_db = db_arc.clone();
            if let Ok(debouncer) = crate::watcher::start_watcher(
                &vault_for_watcher,
                handle_for_watcher,
                watcher_db,
            ) {
                *watcher_arc.lock() = Some(debouncer);
                tracing::info!("File watcher started for vault");
            } else {
                tracing::warn!("Failed to start file watcher");
            }
        });
    }

    // Clean up expired trash entries (>30 days) in background
    {
        let vault_clone = vault_path.clone();
        tokio::task::spawn_blocking(move || {
            crate::commands::trash::cleanup_expired_trash(&vault_clone);
        });
    }

    // Start agent scheduler (periodic background tasks like daily review)
    {
        let agent_state = state.agent_state.clone();
        let vault_clone = vault_path.clone();
        let handle = crate::agent::scheduler::start_scheduler(agent_state.clone(), vault_clone);
        *agent_state.scheduler_handle.lock() = Some(handle);
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

        // Only include supported note files (.md, .typ, .tex) and directories
        if !is_dir && !super::util::is_supported_note_file(&file_name) {
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
