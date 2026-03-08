use std::path::PathBuf;
use std::sync::Arc;

use notify::RecommendedWatcher;
use notify_debouncer_mini::Debouncer;
use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;

/// Global application state shared across Tauri commands.
pub struct AppState {
    pub vault_path: RwLock<Option<PathBuf>>,
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Write connection — used by watcher indexing and note save operations
    pub db: Arc<Mutex<Option<Connection>>>,
    /// Read-only connection — used by search/backlink/graph queries,
    /// separate from write path to avoid read starvation under WAL mode
    pub read_db: Arc<Mutex<Option<Connection>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_path: RwLock::new(None),
            watcher: Mutex::new(None),
            db: Arc::new(Mutex::new(None)),
            read_db: Arc::new(Mutex::new(None)),
        }
    }
}
