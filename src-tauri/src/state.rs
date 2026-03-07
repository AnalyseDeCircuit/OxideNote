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
    pub db: Arc<Mutex<Option<Connection>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            vault_path: RwLock::new(None),
            watcher: Mutex::new(None),
            db: Arc::new(Mutex::new(None)),
        }
    }
}
