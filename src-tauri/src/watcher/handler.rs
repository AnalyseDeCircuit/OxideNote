use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use notify::RecommendedWatcher;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileChangeEvent {
    pub kind: String, // "modify", "remove"
    pub path: String, // vault-relative path
}

/// Start a file system watcher on the vault directory.
/// Returns the debouncer handle — must be kept alive for watching to continue.
pub fn start_watcher(
    vault_path: &Path,
    app_handle: AppHandle,
    db: Arc<Mutex<Option<Connection>>>,
) -> Result<Debouncer<RecommendedWatcher>, String> {
    let vault_root = vault_path.to_path_buf();

    let handle = app_handle.clone();
    let root = vault_root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            match result {
                Ok(events) => {
                    for event in events {
                        let path_str = event.path.to_string_lossy();
                        // Skip hidden files and tmp files
                        if path_str.contains("/.") || path_str.ends_with(".tmp") {
                            continue;
                        }

                        let rel_path = event
                            .path
                            .strip_prefix(&root)
                            .unwrap_or(&event.path)
                            .to_string_lossy()
                            .to_string();

                        // Only emit for .md files or directories
                        let is_md = rel_path.ends_with(".md");
                        let is_dir = event.path.is_dir();
                        if !is_md && !is_dir && event.path.exists() {
                            continue;
                        }

                        let kind = match event.kind {
                            DebouncedEventKind::Any => {
                                if event.path.exists() { "modify" } else { "remove" }
                            }
                            DebouncedEventKind::AnyContinuous => "modify",
                            _ => "modify",
                        };

                        // Incremental indexing for .md files
                        if is_md {
                            let db_guard = db.lock();
                            if let Some(conn) = db_guard.as_ref() {
                                if event.path.exists() {
                                    if let Err(e) = crate::indexing::scanner::index_single_file(&root, &event.path, conn) {
                                        tracing::warn!("Incremental index failed for {}: {}", rel_path, e);
                                    }
                                } else {
                                    if let Err(e) = crate::indexing::scanner::remove_from_index(&root, &event.path, conn) {
                                        tracing::warn!("Remove from index failed for {}: {}", rel_path, e);
                                    }
                                }
                            }
                        }

                        let change = FileChangeEvent {
                            kind: kind.to_string(),
                            path: rel_path,
                        };

                        tracing::debug!("File change: {:?}", change);
                        let _ = handle.emit("vault:file-changed", &change);
                    }
                }
                Err(e) => {
                    tracing::warn!("Watcher error: {:?}", e);
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(vault_path, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    Ok(debouncer)
}
